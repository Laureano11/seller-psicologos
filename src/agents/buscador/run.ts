import type { Db } from '../../db/db.js';
import type { Config } from '../../config.js';
import { AllProvidersFailedError, type Llm } from '../../llm/llm.js';
import { reportDncStatus, type DncChecker } from '../../dnc.js';
import type { WaTransport } from '../../whatsapp/transport.js';
import { toWaId } from '../../phone.js';
import { getProspectByWaId, insertProspect, isOptedOut, kvGet, kvSet, logEvent } from '../../db/repo.js';
import { CITIES } from './cities.js';
import type { ProspectSource } from './sources.js';
import { HttpStatusError, type Browser } from './browser.js';
import { isBlacklisted, type EngineName, type SearchEngine } from './engines.js';
import { extractContacts, fillQuery, hasPhoneHint, loadInstructions, loadQueries, looksLikeTeam } from './extract.js';

export type StopReason =
  | 'tope_prospectos' | 'tope_busquedas' | 'tope_paginas' | 'tope_whatsapp'
  | 'captcha' | 'sin_ia' | 'cancelado' | 'sin_no_llame' | 'fin';

export type BuscadorResult = {
  found: number;
  inserted: number;
  skipped: Record<string, number>;
  searches: number;
  pages: number;
  waChecks: number;
  engine: EngineName | null;
  captcha: boolean;
  stopReason: StopReason;
};

export type BuscadorCursor = { city: number; query: number; page: number };

export type BuscadorDeps = {
  db: Db;
  llm: Llm;
  dnc: DncChecker;
  wa: Pick<WaTransport, 'hasWhatsApp'>;
  /** Fuentes por ciudad (Google Places, si hay clave). */
  sources: ProspectSource[];
  /** Sin esto el Buscador solo usa las fuentes. */
  openBrowser?: () => Promise<Browser>;
  /** Motor principal primero; los siguientes son respaldo ante CAPTCHA. */
  engines: SearchEngine[];
  robots: { allowed(url: string): Promise<boolean> };
  notifyOwner: (text: string) => Promise<unknown>;
  contentDir: string;
  config: Pick<Config, 'buscadorMaxPerDay' | 'buscador'>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/** Páginas de resultados que se recorren por consulta antes de reiniciar el ciclo. */
const MAX_RESULT_PAGES = 3;
/** Pausa aleatoria antes de cada consulta "¿tiene WhatsApp?" (protege el número de Lauri). */
const WA_CHECK_DELAY_MS: [number, number] = [2000, 6000];
/** Días que se recuerda un número sin WhatsApp para no volver a consultarlo. */
const NO_WA_TTL_DAYS = 60;
const DAY_MS = 86_400_000;
const ENGINE_LABEL: Record<EngineName, string> = { bing: 'Bing', google: 'Google', duckduckgo: 'DuckDuckGo' };

class Stop {
  constructor(public reason: StopReason) {}
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Lee el cursor guardado; acepta el formato viejo (un número = índice de ciudad). */
function readCursor(v: unknown, nQueries: number): BuscadorCursor {
  if (isInt(v, 0, CITIES.length - 1)) return { city: v, query: 0, page: 1 };
  if (v && typeof v === 'object') {
    const c = v as Partial<BuscadorCursor>;
    if (isInt(c.city, 0, CITIES.length - 1) && isInt(c.page, 1, MAX_RESULT_PAGES)) {
      return { city: c.city, query: isInt(c.query, 0, nQueries - 1) ? c.query : 0, page: c.page };
    }
  }
  return { city: 0, query: 0, page: 1 };
}

function advance(c: BuscadorCursor, nQueries: number): BuscadorCursor {
  if (c.query + 1 < nQueries) return { ...c, query: c.query + 1 };
  if (c.city + 1 < CITIES.length) return { city: c.city + 1, query: 0, page: c.page };
  return { city: 0, query: 0, page: c.page >= MAX_RESULT_PAGES ? 1 : c.page + 1 };
}

/**
 * Una corrida diaria. Por ciudad (desde el cursor): fuentes (Places) al empezar la ciudad, y con navegador
 * cada consulta de content/buscador-consultas.md -> resultados -> páginas -> IA extrae {nombre, celular, email}.
 * Filtros por contacto: equipo -> sin teléfono -> duplicado -> baja -> No Llame -> tope WhatsApp -> sin WhatsApp.
 * Cortar por tope, CAPTCHA, falta de IA o cancelación es un final normal; solo errores inesperados lanzan.
 */
export async function runBuscador(deps: BuscadorDeps, now: Date, signal?: AbortSignal): Promise<BuscadorResult> {
  const { db, llm, dnc, wa, config } = deps;
  const lim = config.buscador;
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  // pausa que se corta al abortar (apagado del worker)
  const pause = async ([a, b]: [number, number]) => {
    if (signal?.aborted) return;
    let onAbort!: () => void;
    const aborted = new Promise<void>((r) => { onAbort = r; signal?.addEventListener('abort', onAbort, { once: true }); });
    try {
      await Promise.race([sleep(a + (b - a) * random()), aborted]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
  const result: BuscadorResult = {
    found: 0, inserted: 0, skipped: {}, searches: 0, pages: 0, waChecks: 0, engine: null, captcha: false, stopReason: 'fin',
  };
  const skip = (why: string) => { result.skipped[why] = (result.skipped[why] ?? 0) + 1; };
  const finish = () => logEvent(db, 'buscador_run', { ...result, at: now.toISOString() });

  // sin archivo No Llame no se agrega a nadie (ni se abre el navegador)
  if (!(await reportDncStatus(db, dnc))) {
    skip('no_llame_sin_archivo');
    result.stopReason = 'sin_no_llame';
    await finish();
    return result;
  }

  const queries = loadQueries(deps.contentDir);
  const instructions = loadInstructions(deps.contentDir);
  let cursor = readCursor(await kvGet<unknown>(db, 'buscador_cursor'), queries.length);
  let engineIdx = 0;
  let warned = false;
  const visited = new Set<string>();

  // tope de consultas a WhatsApp por DÍA (sobrevive a corridas que fallan y se relanzan)
  const today = now.toISOString().slice(0, 10);
  const prevChecks = await kvGet<{ date: string; n: number }>(db, 'buscador_wa_checks');
  const usedBefore = prevChecks?.date === today && Number.isFinite(prevChecks.n) ? prevChecks.n : 0;
  // números sin WhatsApp ya consultados (con fecha), para no repetir la consulta
  const noWa = new Map<string, string>(Object.entries((await kvGet<Record<string, string>>(db, 'buscador_sin_wa')) ?? {}));
  for (const [id, at] of noWa) if (now.getTime() - Date.parse(at) > NO_WA_TTL_DAYS * DAY_MS) noWa.delete(id);

  const checkAbort = () => { if (signal?.aborted) throw new Stop('cancelado'); };

  async function processContact(
    c: { name: string; phone?: string; email?: string },
    city: { city: string; province: string },
    source: string,
    sourceRef: string,
  ): Promise<void> {
    if (result.inserted >= config.buscadorMaxPerDay) throw new Stop('tope_prospectos');
    result.found++;
    try {
      if (looksLikeTeam(c.name)) return skip('equipo');
      const waId = c.phone ? toWaId(c.phone) : null;
      if (!waId) return skip('sin_telefono');
      if (await getProspectByWaId(db, waId)) return skip('duplicado');
      if (await isOptedOut(db, waId)) return skip('opt_out');
      if (await dnc.isBlocked(waId)) return skip('no_llame');
      if (noWa.has(waId)) return skip('sin_whatsapp');
      if (usedBefore + result.waChecks >= lim.maxWaChecks) throw new Stop('tope_whatsapp');
      await pause(WA_CHECK_DELAY_MS);
      checkAbort();
      result.waChecks++;
      if (!(await wa.hasWhatsApp(waId))) {
        noWa.set(waId, now.toISOString());
        return skip('sin_whatsapp');
      }
      const p = await insertProspect(db, {
        name: c.name, phoneRaw: c.phone, waId, email: c.email, city: city.city, province: city.province,
        source, sourceRef, status: 'encontrado',
      });
      if (p) result.inserted++;
      else skip('duplicado');
    } catch (e) {
      if (e instanceof Stop) throw e;
      skip('error');
      await logEvent(db, 'buscador_raw_error', { name: c.name, sourceRef, error: e instanceof Error ? e.message : String(e) })
        .catch(() => undefined);
    }
  }

  async function processSources(city: { city: string; province: string }): Promise<void> {
    for (const src of deps.sources) {
      let raws;
      try {
        raws = await src.search(city);
      } catch (e) {
        await logEvent(db, 'buscador_source_error', { source: src.name, city: city.city, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      for (const raw of raws) {
        checkAbort();
        await processContact({ name: raw.name, phone: raw.phone }, city, raw.source, raw.sourceRef);
      }
    }
  }

  async function warnCaptcha(blocked: SearchEngine, next: SearchEngine | undefined): Promise<void> {
    if (warned) return;
    warned = true;
    const text = next
      ? `⚠️ ${ENGINE_LABEL[blocked.name]} pidió CAPTCHA al Buscador. Sigo con ${ENGINE_LABEL[next.name]} por hoy.`
      : `⚠️ ${ENGINE_LABEL[blocked.name]} pidió CAPTCHA al Buscador. Corto la búsqueda de hoy y retomo mañana.`;
    await deps.notifyOwner(text).catch(() => undefined);
  }

  async function runQuery(browser: Browser, tpl: string, city: { city: string; province: string }): Promise<void> {
    const query = fillQuery(tpl, city);
    for (;;) {
      checkAbort();
      const engine = deps.engines[engineIdx]!;
      if (result.searches >= lim.maxSearches) throw new Stop('tope_busquedas');
      result.searches++;
      let serp;
      let blocked = false;
      try {
        serp = await browser.open(engine.searchUrl(query, cursor.page), { resultSelector: engine.resultSelector });
        blocked = engine.isBlocked(serp);
      } catch (e) {
        if (!(e instanceof HttpStatusError && (e.status === 403 || e.status === 429))) {
          skip('busqueda_error');
          return;
        }
        blocked = true;
      }
      if (blocked || !serp) {
        result.captcha = true;
        engineIdx++;
        const next = deps.engines[engineIdx];
        await warnCaptcha(engine, next);
        if (!next) throw new Stop('captcha');
        continue; // misma consulta con el motor de respaldo
      }
      result.engine = engine.name;
      const urls = engine.parseResults(serp).filter((u) => !isBlacklisted(u) && !visited.has(u)).slice(0, lim.resultsPerQuery);
      for (const url of urls) {
        checkAbort();
        if (result.pages >= lim.maxPages) throw new Stop('tope_paginas');
        if (!(await deps.robots.allowed(url))) { skip('robots'); continue; }
        await pause(lim.pageDelayMs);
        visited.add(url);
        result.pages++;
        let snap;
        try {
          snap = await browser.open(url);
        } catch {
          skip('pagina_error');
          continue;
        }
        if (!hasPhoneHint(snap)) continue;
        let contacts;
        try {
          contacts = await extractContacts(snap, { llm, instructions });
        } catch (e) {
          if (e instanceof AllProvidersFailedError) throw new Stop('sin_ia');
          throw e;
        }
        for (const c of contacts) await processContact(c, city, engine.name, snap.url);
      }
      return;
    }
  }

  let browser: Browser | undefined;
  try {
    if (deps.openBrowser) {
      try {
        browser = await deps.openBrowser();
      } catch (e) {
        // sin navegador se sigue con las fuentes (Places), como antes
        const why = e instanceof Error ? e.message : String(e);
        await logEvent(db, 'buscador_browser_error', { error: why });
        await deps.notifyOwner(`⚠️ El Buscador no pudo abrir el navegador (${why}). Hoy busco solo con Google Places.`).catch(() => undefined);
      }
    }
    let citiesDone = 0;
    for (;;) {
      checkAbort();
      if (result.inserted >= config.buscadorMaxPerDay) throw new Stop('tope_prospectos');
      if (browser && result.searches >= lim.maxSearches) throw new Stop('tope_busquedas');
      const city = CITIES[cursor.city]!;
      if (cursor.query === 0 && (cursor.page === 1 || !browser)) await processSources(city);
      if (browser) await runQuery(browser, queries[cursor.query]!, city);
      cursor = browser ? advance(cursor, queries.length) : advance({ ...cursor, query: 0, page: 1 }, 1);
      await kvSet(db, 'buscador_cursor', cursor);
      if (!browser) {
        if (++citiesDone >= CITIES.length) throw new Stop('fin');
      } else {
        await pause(lim.searchDelayMs);
      }
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    result.stopReason = e.reason;
  } finally {
    await browser?.close();
    // se guardan siempre, también si la corrida lanza
    await kvSet(db, 'buscador_wa_checks', { date: today, n: usedBefore + result.waChecks }).catch(() => undefined);
    await kvSet(db, 'buscador_sin_wa', Object.fromEntries(noWa)).catch(() => undefined);
  }
  await kvSet(db, 'buscador_cursor', cursor); // un corte a mitad de consulta la repite en la próxima corrida
  await finish();
  return result;
}

/** Borra la marca de "ya corrió hoy": el Orquestador lanza el Buscador en el próximo tick (si ya es SEARCH_HOUR). */
export async function forceBuscadorToday(db: Db): Promise<void> {
  await db.query("DELETE FROM kv WHERE key = 'buscador_last_date'");
}
