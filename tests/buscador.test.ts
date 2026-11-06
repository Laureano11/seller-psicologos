import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { createFakeLlm, AllProvidersFailedError } from '../src/llm/llm.js';
import { createFakeTransport } from '../src/whatsapp/transport.js';
import { CITIES } from '../src/agents/buscador/cities.js';
import { createGooglePlacesSource, type ProspectSource, type RawProspect } from '../src/agents/buscador/sources.js';
import { enrichFromWebsite } from '../src/agents/buscador/enrich.js';
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
const noLlm = createFakeLlm(() => { throw new Error('no debería llamarse'); });
const mkDeps = (sources: ProspectSource[], over: Record<string, unknown> = {}) => {
  const wa = createFakeTransport();
  for (const n of ['5491111111111', '5491122222222', '5491133333333', '5491144444444']) wa.whatsappNumbers.add(n);
  return { db, llm: noLlm, dnc: { isBlocked: async (w: string) => w === '5491133333333' }, sources, wa, config: { buscadorMaxPerDay: 50 }, ...over };
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

describe('enrichFromWebsite', () => {
  it('sin website -> desconocido', async () => {
    expect(await enrichFromWebsite(raw('A', undefined), { llm: noLlm })).toEqual({ practiceType: 'desconocido', toolsSignals: '', fitNotes: '', extra: {} });
  });
  it('extrae con el llm sobre texto sin HTML', async () => {
    let seen = '';
    const llm = createFakeLlm((a) => { seen = a.messages[0]!.content; return { email: 'a@b.com', whatsapp: '11 2222-2222', practiceType: 'equipo', toolsSignals: 'Calendly', fitNotes: 'ok', extra: { especialidad: 'TCC' } }; });
    const fetchFn = (async () => new Response('<html><script>x=1</script><body><p>Hola <b>mundo</b></p></body></html>')) as unknown as typeof fetch;
    const e = await enrichFromWebsite(raw('A', undefined, { website: 'https://a.com' }), { llm, fetchFn });
    expect(e).toMatchObject({ email: 'a@b.com', whatsapp: '11 2222-2222', practiceType: 'equipo', extra: { especialidad: 'TCC' } });
    expect(seen).toContain('Hola mundo');
    expect(seen).not.toContain('<b>');
    expect(seen).not.toContain('x=1');
  });
  it('llm caído -> desconocido', async () => {
    const llm = createFakeLlm(() => { throw new AllProvidersFailedError('x', []); });
    const fetchFn = (async () => new Response('<p>hola</p>')) as unknown as typeof fetch;
    expect((await enrichFromWebsite(raw('A', undefined, { website: 'https://a.com' }), { llm, fetchFn })).practiceType).toBe('desconocido');
  });
});

describe('runBuscador', () => {
  it('filtra duplicado, DNC, sin WhatsApp, sin teléfono, opt-out y inserta el válido', async () => {
    await repo.insertProspect(db, { name: 'Existente', waId: '5491122222222' });
    await db.query("INSERT INTO opt_outs (wa_id) VALUES ('5491144444444')");
    const res = await runBuscador(
      mkDeps([sourceOf([
        raw('Valido', '11 1111-1111'),
        raw('Dup', '11 2222-2222'),
        raw('Dnc', '11 3333-3333'),
        raw('OptOut', '11 4444-4444'),
        raw('SinWa', '11 5555-5555'),
        raw('SinTel', undefined),
      ])]),
      new Date(),
    );
    expect(res.inserted).toBe(1);
    expect(res.found).toBe(6);
    expect(res.skipped).toMatchObject({ duplicado: 1, no_llame: 1, opt_out: 1, sin_whatsapp: 1, sin_telefono: 1 });
    const p = await repo.getProspectByWaId(db, '5491111111111');
    expect(p).toMatchObject({ name: 'Valido', status: 'encontrado', source: 'fake' });
    expect((await repo.listEvents(db, 5)).some((e) => e.type === 'buscador_run')).toBe(true);
  });

  it('corta en el tope y retoma desde el cursor', async () => {
    const all = [raw('A', '11 1111-1111'), raw('B', '11 2222-2222'), raw('C', '11 4444-4444')];
    const deps = mkDeps([sourceOf(all)], { config: { buscadorMaxPerDay: 2 } });
    const r1 = await runBuscador(deps, new Date());
    expect(r1.inserted).toBe(2);
    expect(await repo.kvGet(db, 'buscador_cursor')).toBe(0);
    const r2 = await runBuscador(deps, new Date());
    expect(r2.inserted).toBe(1);
    expect(r2.skipped.duplicado).toBe(2);
    expect(await repo.kvGet(db, 'buscador_cursor')).toBe(0); // dio la vuelta completa
  });

  it('website que falla: inserta igual como desconocido', async () => {
    const fetchFn = (async () => { throw new Error('red'); }) as unknown as typeof fetch;
    const res = await runBuscador(mkDeps([sourceOf([raw('W', '11 1111-1111', { website: 'https://w.com' })])], { fetchFn }), new Date());
    expect(res.inserted).toBe(1);
    expect((await repo.getProspectByWaId(db, '5491111111111'))!.practiceType).toBe('desconocido');
  });

  it('el WhatsApp del sitio tiene prioridad y extra va a attributes', async () => {
    const llm = createFakeLlm(() => ({ email: 'e@x.com', whatsapp: '11 2222-2222', practiceType: 'individual', toolsSignals: 't', fitNotes: 'f', extra: { k: 'v' } }));
    const fetchFn = (async () => new Response('<p>hola</p>')) as unknown as typeof fetch;
    await runBuscador(mkDeps([sourceOf([raw('W', '11 1111-1111', { website: 'https://w.com' })])], { llm, fetchFn }), new Date());
    const p = await repo.getProspectByWaId(db, '5491122222222');
    expect(p).toMatchObject({ email: 'e@x.com', practiceType: 'individual', attributes: { k: 'v' } });
  });

  it('una fuente que tira error se registra y sigue', async () => {
    const bad: ProspectSource = { name: 'mala', search: async () => { throw new Error('boom'); } };
    const res = await runBuscador(mkDeps([bad, sourceOf([raw('A', '11 1111-1111')])]), new Date());
    expect(res.inserted).toBe(1);
    expect((await repo.listEvents(db, 50)).some((e) => e.type === 'buscador_source_error')).toBe(true);
  });

  it('el cursor se guarda y se lee: retoma en una ciudad posterior', async () => {
    const calls: string[] = [];
    const src: ProspectSource = {
      name: 'fake',
      search: async (q) => {
        calls.push(q.city);
        return q.city === CITIES[2]!.city ? [raw('A', '11 1111-1111'), raw('B', '11 2222-2222'), raw('C', '11 4444-4444')] : [];
      },
    };
    const deps = mkDeps([src], { config: { buscadorMaxPerDay: 2 } });
    const r1 = await runBuscador(deps, new Date());
    expect(r1.inserted).toBe(2);
    expect(calls).toEqual([CITIES[0]!.city, CITIES[1]!.city, CITIES[2]!.city]);
    expect(await repo.kvGet(db, 'buscador_cursor')).toBe(2);

    calls.length = 0;
    const r2 = await runBuscador(deps, new Date());
    expect(calls[0]).toBe(CITIES[2]!.city); // no vuelve a las ciudades 0 y 1
    expect(calls.indexOf(CITIES[0]!.city)).toBe(CITIES.length - 2); // recién al final de la vuelta
    expect(r2.inserted).toBe(1);
    // ciudad 2 completada: el cursor avanzó y la corrida siguió hasta dar la vuelta
    expect(calls[1]).toBe(CITIES[3]!.city);
    expect(await repo.kvGet(db, 'buscador_cursor')).toBe(2);
  });

  it('el cursor avanza más allá de una ciudad completada cuando se alcanza el tope justo después', async () => {
    const src: ProspectSource = {
      name: 'fake',
      search: async (q) => (q.city === CITIES[2]!.city ? [raw('A', '11 1111-1111')] : []),
    };
    await runBuscador(mkDeps([src], { config: { buscadorMaxPerDay: 1 } }), new Date());
    expect(await repo.kvGet(db, 'buscador_cursor')).toBe(3);
  });

  it('un error en un raw no aborta la corrida: se cuenta como error y se guarda el cursor', async () => {
    const deps = mkDeps([sourceOf([raw('A', '11 1111-1111'), raw('B', '11 2222-2222')])]);
    let n = 0;
    deps.wa.hasWhatsApp = async (w: string) => {
      if (n++ === 0) throw new Error('desconectado');
      return deps.wa.whatsappNumbers.has(w);
    };
    const res = await runBuscador(deps, new Date());
    expect(res.skipped.error).toBe(1);
    expect(res.inserted).toBe(1);
    expect(await repo.kvGet(db, 'buscador_cursor')).toBe(0);
    expect((await repo.listEvents(db, 100)).some((e) => e.type === 'buscador_run')).toBe(true);
  });

  it('duplicado por teléfono de Places no enriquece (ni fetch ni LLM)', async () => {
    await repo.insertProspect(db, { name: 'Existente', waId: '5491111111111' });
    let llmCalls = 0, fetchCalls = 0;
    const llm = createFakeLlm(() => { llmCalls++; return {}; });
    const fetchFn = (async () => { fetchCalls++; return new Response('x'); }) as unknown as typeof fetch;
    const res = await runBuscador(mkDeps([sourceOf([raw('D', '11 1111-1111', { website: 'https://d.com' })])], { llm, fetchFn }), new Date());
    expect(res.skipped.duplicado).toBe(1);
    expect(llmCalls + fetchCalls).toBe(0);
  });
});
