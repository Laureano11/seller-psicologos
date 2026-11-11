import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { createHubApp } from '../src/hub/app.js';
import { loadPipelineData } from '../src/hub/pipeline.js';
import type { Config } from '../src/config.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from '../src/agents/buscador/archivo.js';

const config = {
  hubUser: 'lauri', hubPassword: 'secreto', dncMode: 'file', abMinPerVariant: 30, tz: 'America/Argentina/Buenos_Aires',
  dailyNewContacts: 5, replyDebounceSeconds: 30, dataDir: mkdtempSync(join(tmpdir(), 'pipe-data-')),
  sendWindow: { days: [1, 2, 3, 4, 5], start: '09:00', end: '20:00' },
  llm: { vendedor: ['google:gemini-2.5-flash', 'groq:llama-3.3-70b-versatile'], analista: [] },
} as unknown as Config;
const auth = { Authorization: 'Basic ' + Buffer.from('lauri:secreto').toString('base64') };
let db: Db;
let app: ReturnType<typeof createHubApp>;

beforeEach(async () => {
  db = await createMemoryDb();
  await migrate(db);
  app = createHubApp({ db, config, answerEscalation: async () => {} });
});
afterEach(async () => { await db.close(); });

const page = async () => (await app.request('/pipeline', { headers: auth })).text();

describe('pipeline', () => {
  it('auth y secciones', async () => {
    expect((await app.request('/pipeline')).status).toBe(401);
    const res = await app.request('/pipeline', { headers: auth });
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const w of ['Buscador', 'Vendedor', 'Orquestador', 'Analista', 'Agenda']) expect(html).toContain(w);
  });

  it('embudo con conteos', async () => {
    for (let i = 0; i < 3; i++) await repo.insertProspect(db, { name: `E${i}`, waId: `54911000000${i}` });
    for (let i = 0; i < 2; i++) await repo.insertProspect(db, { name: `C${i}`, waId: `54922000000${i}`, status: 'contactado' });
    const d = await loadPipelineData(db, config, new Date());
    expect(d.statusCounts.encontrado).toBe(3);
    expect(d.statusCounts.contactado).toBe(2);
    const html = await page();
    expect(html).toMatch(/Encontrado<\/span><div class="track"><div class="bar"[^>]*><\/div><\/div><b>3<\/b>/);
    expect(html).toMatch(/Contactado<\/span><div class="track"><div class="bar"[^>]*><\/div><\/div><b>2<\/b>/);
  });

  it('escapa mensajes', async () => {
    const p = (await repo.insertProspect(db, { name: 'Ana', waId: '5491100000001' }))!;
    await repo.addMessage(db, { prospectId: p.id, direction: 'in', author: 'prospect', body: '<script>alert(1)</script>' });
    const html = await page();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('modelos del vendedor en orden', async () => {
    const html = await page();
    const a = html.indexOf('google:gemini-2.5-flash');
    const b = html.indexOf('groq:llama-3.3-70b-versatile');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  it('outbox pendiente y estado de saliente enviado', async () => {
    const p = (await repo.insertProspect(db, { name: 'Ana', waId: '5491100000001' }))!;
    await repo.enqueueOutbox(db, { prospectId: p.id, toWaId: '5491100000001', body: 'hola', kind: 'prospect', sendAfter: new Date(Date.now() + 3600_000) });
    const id = await repo.enqueueOutbox(db, { prospectId: p.id, toWaId: '5491100000001', body: 'enviado ya', kind: 'prospect', sendAfter: new Date() });
    await repo.markOutboxSent(db, id, 'WA1');
    await repo.addMessage(db, { prospectId: p.id, direction: 'out', author: 'agent', body: 'enviado ya', waMessageId: 'WA1' });
    const html = await page();
    expect(html).toContain('Outbox pendiente');
    expect(html).toContain('5491100000001');
    const d = await loadPipelineData(db, config, new Date());
    expect(d.outbox.pendiente).toBe(1);
    expect(d.messages[0]!.outboxStatus).toBe('enviado');
  });

  it('loadPipelineData expone la última importación y los errores del buscador', async () => {
    await repo.logEvent(db, 'buscador_import', { revisados: 7, cargados: 4, descartes: { no_llame: 3 } });
    await repo.logEvent(db, 'buscador_import_error', { error: 'x' });
    const d = await loadPipelineData(db, config, new Date());
    expect(d.buscador.lastRun).toMatchObject({ revisados: 7, cargados: 4 });
    expect(d.buscador.errors).toHaveLength(1);
  });

  it('muestra data/prospectos.json con el estado de cada psicólogo', async () => {
    const ps = (nombre: string, waId: string) => ({
      nombre, celular: waId.slice(3), waId, ciudad: 'Córdoba', provincia: 'Córdoba', pagina: 'https://a.com', encontradoEl: '2026-11-11T14:00:00.000Z',
    });
    writeJsonAtomic(join(config.dataDir, 'prospectos.json'), [ps('Lic. Ana', '5493511111111'), ps('Lic. Bea', '5493512222222'), ps('Lic. Caro', '5493513333333')]);
    writeJsonAtomic(join(config.dataDir, 'buscador-corridas.json'), [{ ciudad: 'Córdoba', hallados: 5, guardados: 3, descartes: {}, borradosPorBaja: 0, at: '2026-11-11T14:00:00.000Z' }]);
    writeJsonAtomic(join(config.dataDir, 'buscador-estado.json'), { ciudad: 1 });
    await repo.insertProspect(db, { name: 'Lic. Ana', waId: '5493511111111' });
    await repo.kvSet(db, 'importador_descartados', { '5493512222222': 'no_llame' });
    const d = await loadPipelineData(db, config, new Date());
    expect(d.buscadorArchivo).toMatchObject({ total: 3, enBase: 1, pendientes: 1, descartados: { no_llame: 1 } });
    expect(d.buscadorArchivo.ultimos.map((p) => [p.nombre, p.estado])).toEqual([
      ['Lic. Caro', 'pendiente'], ['Lic. Bea', 'descartado (no_llame)'], ['Lic. Ana', 'en la base'],
    ]);
    expect(d.buscadorArchivo.ultimaCorrida).toMatchObject({ guardados: 3 });
    expect(d.cursorCity).toBe('La Plata, Buenos Aires');
    const html = await page();
    expect(html).toContain('Lic. Caro');
    expect(html).toContain('descartado (no_llame)');
  });
});
