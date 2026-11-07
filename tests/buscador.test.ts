import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { createFakeLlm, AllProvidersFailedError } from '../src/llm/llm.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeBrowser, HttpStatusError, type PageSnapshot } from '../src/agents/buscador/browser.js';
import { ENGINES } from '../src/agents/buscador/engines.js';
import { fillQuery, type Contact } from '../src/agents/buscador/extract.js';
import { createFakeTransport } from '../src/whatsapp/transport.js';
import { CITIES } from '../src/agents/buscador/cities.js';
import { createGooglePlacesSource, type ProspectSource, type RawProspect } from '../src/agents/buscador/sources.js';
import { runBuscador } from '../src/agents/buscador/run.js';

let db: Db;
beforeEach(async () => {
  db = await createMemoryDb();
  await migrate(db);
});

afterEach(async () => { await db.close(); });

const raw = (name: string, phone: string | undefined, extra: Partial<RawProspect> = {}): RawProspect => ({
  name, phone, city: 'CABA', province: 'CABA', source: 'fake', sourceRef: name, ...extra,
});
const sourceOf = (raws: RawProspect[]): ProspectSource => ({
  name: 'fake',
  search: async (q) => (q.city === CITIES[0]!.city ? raws : []),
});
const Q1 = 'q1 {ciudad}';
const Q2 = 'q2 {ciudad}';
const contentWith = (queries: string[]) => {
  const d = mkdtempSync(join(tmpdir(), 'busc-run-'));
  writeFileSync(join(d, 'buscador-consultas.md'), queries.join('\n'));
  writeFileSync(join(d, 'buscador-instrucciones.md'), 'INSTRUCCIONES');
  return d;
};
const gUrl = (tpl: string, city = 0, page = 1) => ENGINES.google.searchUrl(fillQuery(tpl, CITIES[city]!), page);
const dUrl = (tpl: string, city = 0, page = 1) => ENGINES.duckduckgo.searchUrl(fillQuery(tpl, CITIES[city]!), page);
const results = (url: string, hrefs: string[]): PageSnapshot => ({ url, text: 'resultados', links: hrefs.map((href) => ({ href, text: '' })) });
const ddgResults = (url: string, hrefs: string[]): PageSnapshot =>
  results(url, hrefs.map((h) => `https://duckduckgo.com/l/?uddg=${encodeURIComponent(h)}`));
const page = (url: string, people: Contact[]): PageSnapshot => ({
  url, text: people.map((c) => `${c.name} ${c.phone} ${c.email ?? ''}`).join('\n'), links: [],
});
const captcha = (url: string): PageSnapshot => ({ url: 'https://www.google.com/sorry/index', text: 'tráfico inusual', links: [] });
const c = (name: string, phone: string, email?: string): Contact => (email ? { name, phone, email } : { name, phone });
const noLlm = createFakeLlm(() => { throw new Error('no debería llamarse'); });
const BUSCADOR_TEST = {
  maxSearches: 1, maxPages: 50, resultsPerQuery: 10, maxWaChecks: 50,
  searchDelayMs: [0, 0] as [number, number], pageDelayMs: [0, 0] as [number, number], engine: 'google' as const, profileDir: 'x',
};
const WA_OK = ['5491111111111', '5491122222222', '5491133333333', '5491144444444', '5491166666666', '5491177777777'];

/** Mundo de prueba: navegador falso + IA falsa que devuelve los contactos de cada URL. */
const mkWorld = (
  pages: Record<string, PageSnapshot | Error>,
  contacts: Record<string, Contact[]>,
  over: { queries?: string[]; buscador?: Partial<typeof BUSCADOR_TEST>; maxPerDay?: number; [k: string]: unknown } = {},
) => {
  const { queries, buscador, maxPerDay, ...rest } = over;
  const browser = createFakeBrowser(pages);
  const wa = createFakeTransport();
  for (const n of WA_OK) wa.whatsappNumbers.add(n);
  const llmCalls: string[] = [];
  const llm = createFakeLlm((a) => {
    const url = /^Página: (\S+)/.exec(a.messages[0]!.content)![1]!;
    llmCalls.push(url);
    return { contacts: contacts[url] ?? [] };
  });
  const notes: string[] = [];
  const deps = {
    db, llm, wa, sources: [] as ProspectSource[],
    dnc: { isBlocked: async (w: string) => w === '5491133333333' },
    openBrowser: async () => browser,
    engines: [ENGINES.google, ENGINES.duckduckgo],
    robots: { allowed: async (u: string) => !u.includes('prohibido') },
    notifyOwner: async (t: string) => { notes.push(t); },
    contentDir: contentWith(queries ?? [Q1]),
    config: { buscadorMaxPerDay: maxPerDay ?? 50, buscador: { ...BUSCADOR_TEST, ...buscador } },
    sleep: async () => {},
    ...rest,
  };
  return { deps, browser, wa, notes, llmCalls };
};
/** Places solo (sin navegador), como corría antes. */
const mkDeps = (sources: ProspectSource[], over: Record<string, unknown> = {}) => {
  const w = mkWorld({}, {}, { sources, openBrowser: undefined, llm: noLlm, ...over });
  return w.deps;
};

describe('cities', () => {
  it('al menos 40, CABA primero', () => {
    expect(CITIES.length).toBeGreaterThanOrEqual(40);
    expect(CITIES[0]!.city).toMatch(/Buenos Aires|CABA/);
  });
});

describe('google places', () => {
  it('manda field mask y query exactos y mapea campos', async () => {
    let call: { url: string; init: RequestInit } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      call = { url, init };
      return new Response(JSON.stringify({ places: [{ id: 'p1', displayName: { text: 'Lic. Ana' }, formattedAddress: 'Calle 1', internationalPhoneNumber: '+54 9 11 1111-1111', websiteUri: 'https://ana.com' }] }));
    }) as unknown as typeof fetch;
    const out = await createGooglePlacesSource('KEY', fetchFn).search({ city: 'Rosario', province: 'Santa Fe' });
    expect(call!.url).toBe('https://places.googleapis.com/v1/places:searchText');
    const h = call!.init.headers as Record<string, string>;
    expect(h['X-Goog-FieldMask']).toBe('places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri');
    expect(JSON.parse(call!.init.body as string)).toEqual({ textQuery: 'psicólogo en Rosario, Santa Fe, Argentina', languageCode: 'es' });
    expect(out).toEqual([{ name: 'Lic. Ana', phone: '+54 9 11 1111-1111', website: 'https://ana.com', address: 'Calle 1', city: 'Rosario', province: 'Santa Fe', source: 'google_places', sourceRef: 'p1' }]);
  });
});

describe('runBuscador: navegador', () => {
  const R = 'https://ana.com/contacto';
  it('sin No Llame -> sin_no_llame y no abre el navegador', async () => {
    let opened = false;
    const w = mkWorld({}, {}, { dnc: { isBlocked: async () => false, missingFile: () => 'falta.csv' }, openBrowser: async () => { opened = true; return createFakeBrowser({}); } });
    const r = await runBuscador(w.deps, new Date());
    expect(r.stopReason).toBe('sin_no_llame');
    expect(opened).toBe(false);
  });

  it('guarda nombre, celular, email, ciudad, source google y source_ref = URL de la página', async () => {
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), [R]), [R]: page(R, [c('Lic. Ana Gómez', '11 1111-1111', 'ana@a.com')]) }, { [R]: [c('Lic. Ana Gómez', '11 1111-1111', 'ana@a.com')] });
    const r = await runBuscador(w.deps, new Date());
    expect(r.inserted).toBe(1);
    expect(await repo.getProspectByWaId(db, '5491111111111')).toMatchObject({
      name: 'Lic. Ana Gómez', email: 'ana@a.com', city: CITIES[0]!.city, province: CITIES[0]!.province,
      source: 'google', sourceRef: R, status: 'encontrado',
    });
    expect(r).toMatchObject({ searches: 1, pages: 1, waChecks: 1, engine: 'google', captcha: false, stopReason: 'tope_busquedas' });
  });

  it('filtros en orden: equipo, sin_telefono, duplicado, opt_out, no_llame, sin_whatsapp', async () => {
    await repo.insertProspect(db, { name: 'Existente', waId: '5491122222222' });
    await db.query("INSERT INTO opt_outs (wa_id) VALUES ('5491144444444')");
    const people = [
      c('Centro Psi', '11 1111-1111'), c('Lic. SinTel', '12345678'), c('Lic. Dup', '11 2222-2222'),
      c('Lic. Baja', '11 4444-4444'), c('Lic. Dnc', '11 3333-3333'), c('Lic. SinWa', '11 5555-5555'), c('Lic. Ok', '11 6666-6666'),
    ];
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), [R]), [R]: page(R, people) }, { [R]: people });
    const r = await runBuscador(w.deps, new Date());
    expect(r.inserted).toBe(1);
    expect(r.skipped).toEqual({ equipo: 1, sin_telefono: 1, duplicado: 1, opt_out: 1, no_llame: 1, sin_whatsapp: 1 });
    expect(r.waChecks).toBe(2);
  });

  it('mismo número en dos páginas -> 1 insertado, 1 duplicado', async () => {
    const R2 = 'https://listado.com/psi';
    const w = mkWorld(
      { [gUrl(Q1)]: results(gUrl(Q1), [R, R2]), [R]: page(R, [c('Lic. Ana', '11 1111-1111')]), [R2]: page(R2, [c('Ana G.', '+54 9 11 1111-1111')]) },
      { [R]: [c('Lic. Ana', '11 1111-1111')], [R2]: [c('Ana G.', '+54 9 11 1111-1111')] },
    );
    const r = await runBuscador(w.deps, new Date());
    expect(r.inserted).toBe(1);
    expect(r.skipped.duplicado).toBe(1);
  });

  it('salta lista negra y robots prohibido sin abrirlas', async () => {
    const bad1 = 'https://www.linkedin.com/in/ana', bad2 = 'https://a.com/prohibido';
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), [bad1, bad2, R]), [R]: page(R, []) }, {});
    const r = await runBuscador(w.deps, new Date());
    expect(w.browser.opened).toEqual([gUrl(Q1), R]);
    expect(r.skipped.robots).toBe(1);
  });

  it('pide los resultados con el selector del motor', async () => {
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), []) }, {});
    const seen: (string | undefined)[] = [];
    const open = w.browser.open.bind(w.browser);
    w.browser.open = async (u: string, o?: { resultSelector?: string }) => { seen.push(o?.resultSelector); return open(u); };
    await runBuscador(w.deps, new Date());
    expect(seen).toEqual(['#search a:has(h3)']);
  });

  it('página sin indicio de teléfono no llama a la IA', async () => {
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), [R]), [R]: { url: R, text: 'sin datos', links: [] } }, {});
    await runBuscador(w.deps, new Date());
    expect(w.llmCalls).toEqual([]);
  });

  it('página que lanza al abrir -> pagina_error y sigue con la siguiente', async () => {
    const R2 = 'https://bea.com/b';
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), [R, R2]), [R]: new Error('timeout'), [R2]: page(R2, [c('Lic. Bea', '11 1111-1111')]) }, { [R2]: [c('Lic. Bea', '11 1111-1111')] });
    const r = await runBuscador(w.deps, new Date());
    expect(r.skipped.pagina_error).toBe(1);
    expect(r.inserted).toBe(1);
  });

  it('topes: prospectos, páginas y WhatsApp cortan sin pasarse', async () => {
    const people = [c('Lic. A', '11 1111-1111'), c('Lic. B', '11 2222-2222'), c('Lic. C', '11 6666-6666')];
    const R2 = 'https://b.com';
    const pages = { [gUrl(Q1)]: results(gUrl(Q1), [R, R2]), [R]: page(R, people), [R2]: page(R2, people) };
    const r1 = await runBuscador(mkWorld(pages, { [R]: people }, { maxPerDay: 2 }).deps, new Date());
    expect(r1).toMatchObject({ inserted: 2, stopReason: 'tope_prospectos' });
    await db.query('DELETE FROM prospects');
    const r2 = await runBuscador(mkWorld(pages, { [R]: people }, { buscador: { maxPages: 1 } }).deps, new Date());
    expect(r2).toMatchObject({ pages: 1, stopReason: 'tope_paginas' });
    await db.query('DELETE FROM prospects');
    const r3 = await runBuscador(mkWorld(pages, { [R]: people }, { buscador: { maxWaChecks: 1 } }).deps, new Date());
    expect(r3).toMatchObject({ waChecks: 1, inserted: 1, stopReason: 'tope_whatsapp' });
  });

  it('tope de búsquedas', async () => {
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), []), [gUrl(Q2)]: results(gUrl(Q2), []) }, {}, { queries: [Q1, Q2], buscador: { maxSearches: 2 } });
    const r = await runBuscador(w.deps, new Date());
    expect(r).toMatchObject({ searches: 2, stopReason: 'tope_busquedas' });
  });

  it('CAPTCHA en google -> avisa una vez y sigue con duckduckgo', async () => {
    const w = mkWorld({ [gUrl(Q1)]: captcha(gUrl(Q1)), [dUrl(Q1)]: ddgResults(dUrl(Q1), [R]), [R]: page(R, [c('Lic. Ana', '11 1111-1111')]) }, { [R]: [c('Lic. Ana', '11 1111-1111')] }, { buscador: { maxSearches: 2 } });
    const r = await runBuscador(w.deps, new Date());
    expect(r).toMatchObject({ engine: 'duckduckgo', captcha: true, inserted: 1 });
    expect(w.notes).toEqual(['⚠️ Google pidió CAPTCHA al Buscador. Sigo con DuckDuckGo por hoy.']);
    expect(await repo.getProspectByWaId(db, '5491111111111')).toMatchObject({ source: 'duckduckgo' });
  });

  it('HTTP 403 en la página de resultados cuenta como bloqueo y pasa al respaldo', async () => {
    const w = mkWorld({ [gUrl(Q1)]: new HttpStatusError(403, gUrl(Q1)), [dUrl(Q1)]: ddgResults(dUrl(Q1), []) }, {}, { buscador: { maxSearches: 2 } });
    const r = await runBuscador(w.deps, new Date());
    expect(r).toMatchObject({ captcha: true, engine: 'duckduckgo' });
    expect(w.notes).toHaveLength(1);
  });

  it('CAPTCHA en los dos motores -> captcha, sin lanzar', async () => {
    const w = mkWorld({ [gUrl(Q1)]: captcha(gUrl(Q1)), [dUrl(Q1)]: { url: dUrl(Q1), text: 'anomaly detected', links: [] } }, {}, { buscador: { maxSearches: 5 } });
    const r = await runBuscador(w.deps, new Date());
    expect(r.stopReason).toBe('captcha');
    expect(w.notes).toHaveLength(1);
  });

  it('sin IA -> sin_ia, sin lanzar', async () => {
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), [R]), [R]: page(R, [c('Lic. Ana', '11 1111-1111')]) }, {}, { llm: createFakeLlm(() => { throw new AllProvidersFailedError('x', []); }) });
    expect((await runBuscador(w.deps, new Date())).stopReason).toBe('sin_ia');
  });

  it('signal abortado -> cancelado y cierra el navegador', async () => {
    const w = mkWorld({}, {});
    const ac = new AbortController();
    ac.abort();
    expect((await runBuscador(w.deps, new Date(), ac.signal)).stopReason).toBe('cancelado');
    expect(w.browser.closed).toBe(true);
  });

  it('cierra el navegador también si algo lanza', async () => {
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), []) }, {}, { robots: { allowed: async () => { throw new Error('boom'); } } });
    w.deps.notifyOwner = async () => { throw new Error('no'); };
    const bad = { ...w.deps, engines: [{ ...ENGINES.google, parseResults: () => { throw new Error('parser roto'); } }] };
    await expect(runBuscador(bad, new Date())).rejects.toThrow('parser roto');
    expect(w.browser.closed).toBe(true);
  });

  it('cursor guardado tras cada consulta terminada', async () => {
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), []) }, {}, { queries: [Q1, Q2] });
    await runBuscador(w.deps, new Date());
    expect(await repo.kvGet(db, 'buscador_cursor')).toEqual({ city: 0, query: 1, page: 1 });
  });

  it('al pasar la última ciudad, page sube; después de 3 vuelve a 1', async () => {
    const last = CITIES.length - 1;
    await repo.kvSet(db, 'buscador_cursor', { city: last, query: 0, page: 1 });
    await runBuscador(mkWorld({ [gUrl(Q1, last, 1)]: results('x', []) }, {}).deps, new Date());
    expect(await repo.kvGet(db, 'buscador_cursor')).toEqual({ city: 0, query: 0, page: 2 });
    await repo.kvSet(db, 'buscador_cursor', { city: last, query: 0, page: 3 });
    const w = mkWorld({ [gUrl(Q1, last, 3)]: results('x', []) }, {});
    await runBuscador(w.deps, new Date());
    expect(w.browser.opened[0]).toBe(gUrl(Q1, last, 3));
    expect(await repo.kvGet(db, 'buscador_cursor')).toEqual({ city: 0, query: 0, page: 1 });
  });

  it('cursor viejo numérico 3 -> arranca en { city: 3, query: 0, page: 1 }', async () => {
    await repo.kvSet(db, 'buscador_cursor', 3);
    const w = mkWorld({ [gUrl(Q1, 3)]: results('x', []) }, {});
    await runBuscador(w.deps, new Date());
    expect(w.browser.opened[0]).toBe(gUrl(Q1, 3, 1));
  });

  it('Places solo al empezar una ciudad, con source google_places y source_ref = id', async () => {
    const calls: string[] = [];
    const places: ProspectSource = { name: 'google_places', search: async (q) => { calls.push(q.city); return [raw('Lic. P', '11 1111-1111', { source: 'google_places', sourceRef: 'place-1' })]; } };
    const w = mkWorld({ [gUrl(Q1)]: results('x', []) }, {}, { sources: [places], queries: [Q1, Q2] });
    await runBuscador(w.deps, new Date());
    expect(calls).toEqual([CITIES[0]!.city]);
    expect(await repo.getProspectByWaId(db, '5491111111111')).toMatchObject({ source: 'google_places', sourceRef: 'place-1' });
    calls.length = 0;
    await runBuscador(mkWorld({ [gUrl(Q2)]: results('x', []) }, {}, { sources: [places], queries: [Q1, Q2] }).deps, new Date());
    expect(calls).toEqual([]);
  });

  it('evento buscador_run con el resumen', async () => {
    await runBuscador(mkWorld({ [gUrl(Q1)]: results('x', []) }, {}).deps, new Date());
    const ev = (await repo.listEvents(db, 10)).find((e) => e.type === 'buscador_run');
    expect(ev?.payload).toMatchObject({ found: 0, inserted: 0, searches: 1, pages: 0, waChecks: 0, engine: 'google', captcha: false, stopReason: 'tope_busquedas' });
  });

  it('las instrucciones de content/ llegan a la IA', async () => {
    let system = '';
    const w = mkWorld({ [gUrl(Q1)]: results(gUrl(Q1), [R]), [R]: page(R, [c('Lic. Ana', '11 1111-1111')]) }, {}, { llm: createFakeLlm((a) => { system = a.system; return { contacts: [] }; }) });
    await runBuscador(w.deps, new Date());
    expect(system).toBe('INSTRUCCIONES');
  });
});

describe('runBuscador: solo Places', () => {
  it('filtra duplicado, DNC, sin WhatsApp, sin teléfono, opt-out, equipo e inserta el válido', async () => {
    await repo.insertProspect(db, { name: 'Existente', waId: '5491122222222' });
    await db.query("INSERT INTO opt_outs (wa_id) VALUES ('5491144444444')");
    const res = await runBuscador(
      mkDeps([sourceOf([
        raw('Valido', '11 1111-1111'), raw('Dup', '11 2222-2222'), raw('Dnc', '11 3333-3333'),
        raw('OptOut', '11 4444-4444'), raw('SinWa', '11 5555-5555'), raw('SinTel', undefined), raw('Instituto X', '11 6666-6666'),
      ])]),
      new Date(),
    );
    expect(res.inserted).toBe(1);
    expect(res.found).toBe(7);
    expect(res.skipped).toEqual({ duplicado: 1, no_llame: 1, opt_out: 1, sin_whatsapp: 1, sin_telefono: 1, equipo: 1 });
    expect(await repo.getProspectByWaId(db, '5491111111111')).toMatchObject({ name: 'Valido', status: 'encontrado', source: 'fake' });
    expect(res.stopReason).toBe('fin');
  });

  it('corta en el tope y retoma en la misma ciudad', async () => {
    const all = [raw('A', '11 1111-1111'), raw('B', '11 2222-2222'), raw('C', '11 6666-6666')];
    const deps = mkDeps([sourceOf(all)], { maxPerDay: 2 });
    const r1 = await runBuscador(deps, new Date());
    expect(r1).toMatchObject({ inserted: 2, stopReason: 'tope_prospectos' });
    expect(await repo.kvGet(db, 'buscador_cursor')).toEqual({ city: 0, query: 0, page: 1 });
    const r2 = await runBuscador(deps, new Date());
    expect(r2.inserted).toBe(1);
    expect(r2.skipped.duplicado).toBe(2);
  });

  it('tope alcanzado justo al terminar una ciudad: el cursor avanza y no recorre el resto', async () => {
    const calls: string[] = [];
    const src: ProspectSource = { name: 'fake', search: async (q) => { calls.push(q.city); return q.city === CITIES[2]!.city ? [raw('A', '11 1111-1111')] : []; } };
    await repo.kvSet(db, 'buscador_cursor', 2);
    const r = await runBuscador(mkDeps([src], { maxPerDay: 1 }), new Date());
    expect(r.stopReason).toBe('tope_prospectos');
    expect(calls).toEqual([CITIES[2]!.city]);
    expect(await repo.kvGet(db, 'buscador_cursor')).toEqual({ city: 3, query: 0, page: 1 });
  });

  it('una fuente que tira error se registra y sigue', async () => {
    const bad: ProspectSource = { name: 'mala', search: async () => { throw new Error('boom'); } };
    const res = await runBuscador(mkDeps([bad, sourceOf([raw('A', '11 1111-1111')])]), new Date());
    expect(res.inserted).toBe(1);
    expect((await repo.listEvents(db, 50)).some((e) => e.type === 'buscador_source_error')).toBe(true);
  });

  it('un error en un contacto no aborta la corrida', async () => {
    const deps = mkDeps([sourceOf([raw('A', '11 1111-1111'), raw('B', '11 2222-2222')])]);
    let n = 0;
    deps.wa.hasWhatsApp = async (w: string) => {
      if (n++ === 0) throw new Error('desconectado');
      return deps.wa.whatsappNumbers.has(w);
    };
    const res = await runBuscador(deps, new Date());
    expect(res.skipped.error).toBe(1);
    expect(res.inserted).toBe(1);
  });
});
