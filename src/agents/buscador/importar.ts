import { join } from 'node:path';
import type { Db } from '../../db/db.js';
import type { Config } from '../../config.js';
import { reportDncStatus, type DncChecker } from '../../dnc.js';
import type { WaTransport } from '../../whatsapp/transport.js';
import { getProspectByWaId, insertProspect, isOptedOut, kvGet, kvSet, listOptOutWaIds, logEvent } from '../../db/repo.js';
import { BAJAS_FILE, PROSPECTOS_FILE, readJson, writeJsonAtomic, type Psicologo } from './archivo.js';

export type ImportStopReason = 'fin' | 'tope_whatsapp' | 'cancelado' | 'sin_no_llame';

export type ImportResult = {
  revisados: number;
  cargados: number;
  descartes: Record<string, number>;
  waChecks: number;
  stopReason: ImportStopReason;
};

export type ImportDeps = {
  db: Db;
  dnc: DncChecker;
  wa: Pick<WaTransport, 'hasWhatsApp'>;
  dataDir: string;
  config: Pick<Config, 'buscador'>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/** Pausa aleatoria antes de cada consulta "¿tiene WhatsApp?" (protege el número de Lauri). */
const WA_CHECK_DELAY_MS: [number, number] = [2000, 6000];
/** Días que se recuerda un número sin WhatsApp para no volver a consultarlo. */
const NO_WA_TTL_DAYS = 60;
const DAY_MS = 86_400_000;

class Stop {
  constructor(public reason: ImportStopReason) {}
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Pasa a la base los psicólogos nuevos de data/prospectos.json (los escribe el Buscador en la Mac).
 * Por cada uno que no esté ya en la base ni descartado: baja → No Llame → sin WhatsApp (con tope diario).
 * Los que pasan quedan como `encontrado` para el Vendedor. También publica las bajas en data/bajas.json.
 */
export async function runImportador(deps: ImportDeps, now: Date, signal?: AbortSignal): Promise<ImportResult> {
  const { db, dnc, wa } = deps;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  const result: ImportResult = { revisados: 0, cargados: 0, descartes: {}, waChecks: 0, stopReason: 'fin' };
  const skip = (why: string) => { result.descartes[why] = (result.descartes[why] ?? 0) + 1; };

  // bajas para que la Mac las borre del .json (Ley 25.326)
  writeJsonAtomic(join(deps.dataDir, BAJAS_FILE), await listOptOutWaIds(db));

  const raw = readJson<unknown>(join(deps.dataDir, PROSPECTOS_FILE), []);
  const lista = (Array.isArray(raw) ? raw : []).filter(
    (p): p is Psicologo => Boolean(p) && typeof p.waId === 'string' && typeof p.nombre === 'string',
  );
  const descartados = (await kvGet<Record<string, string>>(db, 'importador_descartados')) ?? {};
  const pendientes: Psicologo[] = [];
  for (const p of lista) {
    if (descartados[p.waId] || (await getProspectByWaId(db, p.waId))) continue;
    pendientes.push(p);
  }
  if (!pendientes.length) return result;

  const today = now.toISOString().slice(0, 10);
  const prevChecks = await kvGet<{ date: string; n: number }>(db, 'buscador_wa_checks');
  const usedBefore = prevChecks?.date === today && Number.isFinite(prevChecks.n) ? prevChecks.n : 0;
  const noWa = new Map<string, string>(Object.entries((await kvGet<Record<string, string>>(db, 'buscador_sin_wa')) ?? {}));
  for (const [id, at] of noWa) if (now.getTime() - Date.parse(at) > NO_WA_TTL_DAYS * DAY_MS) noWa.delete(id);

  const discard = (p: Psicologo, why: string) => { descartados[p.waId] = why; skip(why); };
  const pause = async () => {
    if (signal?.aborted) return;
    let onAbort!: () => void;
    const aborted = new Promise<void>((r) => { onAbort = r; signal?.addEventListener('abort', onAbort, { once: true }); });
    try {
      await Promise.race([sleep(WA_CHECK_DELAY_MS[0] + (WA_CHECK_DELAY_MS[1] - WA_CHECK_DELAY_MS[0]) * random()), aborted]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };

  try {
    // sin archivo No Llame no se carga a nadie (el evento se registra una vez, no en cada pasada)
    const dncError = Boolean(await kvGet(db, 'dnc_error'));
    if (dnc.missingFile?.()) {
      if (!dncError) await reportDncStatus(db, dnc);
      throw new Stop('sin_no_llame');
    }
    if (dncError) await reportDncStatus(db, dnc); // apareció el archivo: se limpia el aviso del hub
    for (const p of pendientes) {
      if (signal?.aborted) throw new Stop('cancelado');
      result.revisados++;
      try {
        if (await isOptedOut(db, p.waId)) { discard(p, 'baja'); continue; }
        if (await dnc.isBlocked(p.waId)) { discard(p, 'no_llame'); continue; }
        if (noWa.has(p.waId)) { skip('sin_whatsapp'); continue; }
        if (usedBefore + result.waChecks >= deps.config.buscador.maxWaChecks) throw new Stop('tope_whatsapp');
        await pause();
        if (signal?.aborted) throw new Stop('cancelado');
        result.waChecks++;
        if (!(await wa.hasWhatsApp(p.waId))) {
          noWa.set(p.waId, now.toISOString());
          skip('sin_whatsapp');
          continue;
        }
        const ins = await insertProspect(db, {
          name: p.nombre, phoneRaw: p.celular, waId: p.waId, email: p.email, city: p.ciudad, province: p.provincia,
          source: 'claude', sourceRef: p.pagina, status: 'encontrado',
        });
        if (ins) result.cargados++;
      } catch (e) {
        if (e instanceof Stop) throw e;
        skip('error');
        await logEvent(db, 'buscador_import_error', { waId: p.waId, error: e instanceof Error ? e.message : String(e) })
          .catch(() => undefined);
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    result.stopReason = e.reason;
  } finally {
    await kvSet(db, 'buscador_wa_checks', { date: today, n: usedBefore + result.waChecks }).catch(() => undefined);
    await kvSet(db, 'buscador_sin_wa', Object.fromEntries(noWa)).catch(() => undefined);
    await kvSet(db, 'importador_descartados', descartados).catch(() => undefined);
  }
  await logEvent(db, 'buscador_import', { ...result, at: now.toISOString() });
  return result;
}
