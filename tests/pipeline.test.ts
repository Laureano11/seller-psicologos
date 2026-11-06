import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { createHubApp } from '../src/hub/app.js';
import { loadPipelineData } from '../src/hub/pipeline.js';
import type { Config } from '../src/config.js';

const config = {
  hubUser: 'lauri', hubPassword: 'secreto', dncMode: 'file', abMinPerVariant: 30, tz: 'America/Argentina/Buenos_Aires',
  dailyNewContacts: 5, replyDebounceSeconds: 30, searchHour: 9,
  sendWindow: { days: [1, 2, 3, 4, 5], start: '09:00', end: '20:00' },
  llm: { buscador: ['google:gemini-2.5-flash'], vendedor: ['google:gemini-2.5-flash', 'groq:llama-3.3-70b-versatile'], analista: [] },
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
    expect(html).toMatch(/Encontrado<\/span><div class="bar"[^>]*><\/div><b>3<\/b>/);
    expect(html).toMatch(/Contactado<\/span><div class="bar"[^>]*><\/div><b>2<\/b>/);
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

  it('loadPipelineData expone buscador_run', async () => {
    await repo.logEvent(db, 'buscador_run', { found: 7, inserted: 4, skipped: { duplicado: 3 } });
    await repo.logEvent(db, 'buscador_source_error', { error: 'x' });
    const d = await loadPipelineData(db, config, new Date());
    expect(d.buscador.lastRun).toMatchObject({ found: 7, inserted: 4 });
    expect(d.buscador.errors).toHaveLength(1);
  });
});
