import type { Db } from '../../db/db.js';
import type { Config } from '../../config.js';
import type { Llm } from '../../llm/llm.js';
import type { DncChecker } from '../../dnc.js';
import type { WaTransport } from '../../whatsapp/transport.js';
import { toWaId } from '../../phone.js';
import { getProspectByWaId, insertProspect, isOptedOut, kvGet, kvSet, logEvent } from '../../db/repo.js';
import { CITIES } from './cities.js';
import { enrichFromWebsite } from './enrich.js';
import type { ProspectSource, RawProspect } from './sources.js';

export type BuscadorDeps = {
  db: Db;
  llm: Llm;
  dnc: DncChecker;
  sources: ProspectSource[];
  wa: Pick<WaTransport, 'hasWhatsApp'>;
  config: Pick<Config, 'buscadorMaxPerDay'>;
  fetchFn?: typeof fetch;
};

export type BuscadorResult = { found: number; inserted: number; skipped: Record<string, number> };

/**
 * Orden por raw: si hay website y el teléfono de Places no corresponde a un prospecto ya existente, se enriquece
 * (el WhatsApp del sitio tiene prioridad); luego toWaId -> duplicado -> opt-out -> No Llame -> hasWhatsApp -> insert.
 */
export async function runBuscador(deps: BuscadorDeps, now: Date): Promise<BuscadorResult> {
  const { db, llm, dnc, sources, wa, config } = deps;
  const result: BuscadorResult = { found: 0, inserted: 0, skipped: {} };
  const skip = (why: string) => { result.skipped[why] = (result.skipped[why] ?? 0) + 1; };
  const max = config.buscadorMaxPerDay;

  let cursor = (await kvGet<number>(db, 'buscador_cursor')) ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= CITIES.length) cursor = 0;

  async function processRaw(raw: RawProspect): Promise<void> {
    result.found++;
    const placesWaId = raw.phone ? toWaId(raw.phone) : null;
    if (placesWaId && (await getProspectByWaId(db, placesWaId))) return skip('duplicado');

    const enr = await enrichFromWebsite(raw, { llm, fetchFn: deps.fetchFn });
    const enrWaId = enr.whatsapp ? toWaId(enr.whatsapp) : null;
    const waId = enrWaId ?? placesWaId;
    if (!waId) return skip('sin_telefono');
    if (await getProspectByWaId(db, waId)) return skip('duplicado');
    if (await isOptedOut(db, waId)) return skip('opt_out');
    if (await dnc.isBlocked(waId)) return skip('no_llame');
    if (!(await wa.hasWhatsApp(waId))) return skip('sin_whatsapp');

    const p = await insertProspect(db, {
      name: raw.name,
      phoneRaw: enrWaId ? enr.whatsapp : raw.phone,
      waId,
      email: enr.email,
      city: raw.city,
      province: raw.province,
      address: raw.address,
      website: raw.website,
      source: raw.source,
      sourceRef: raw.sourceRef,
      profileUrls: raw.profileUrls ?? [],
      practiceType: enr.practiceType,
      toolsSignals: enr.toolsSignals,
      fitNotes: enr.fitNotes,
      attributes: enr.extra,
      status: 'encontrado',
    });
    if (p) result.inserted++;
    else skip('duplicado');
  }

  let visited = 0;
  while (visited < CITIES.length && result.inserted < max) {
    const q = CITIES[cursor]!;
    let complete = true;
    for (const src of sources) {
      let raws: RawProspect[];
      try {
        raws = await src.search(q);
      } catch (e) {
        await logEvent(db, 'buscador_source_error', {
          source: src.name, city: q.city, error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      for (const raw of raws) {
        if (result.inserted >= max) { complete = false; break; }
        try {
          await processRaw(raw);
        } catch (e) {
          skip('error');
          await logEvent(db, 'buscador_raw_error', {
            name: raw.name, sourceRef: raw.sourceRef, error: e instanceof Error ? e.message : String(e),
          }).catch(() => undefined);
        }
      }
      if (!complete) break;
    }
    if (!complete) break; // el cursor queda en esta ciudad: la próxima corrida retoma (los ya insertados salen como duplicado)
    cursor = (cursor + 1) % CITIES.length;
    visited++;
  }
  await kvSet(db, 'buscador_cursor', cursor);
  await logEvent(db, 'buscador_run', { ...result, at: now.toISOString() });
  return result;
}
