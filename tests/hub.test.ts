import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { createHubApp } from '../src/hub/app.js';
import type { Config } from '../src/config.js';

const config = { hubUser: 'lauri', hubPassword: 'secreto', dncMode: 'file', abMinPerVariant: 30 } as Config;
const auth = { Authorization: 'Basic ' + Buffer.from('lauri:secreto').toString('base64') };
let db: Db;
let answer: ReturnType<typeof vi.fn>;
let app: ReturnType<typeof createHubApp>;

const form = (o: Record<string, string>) => ({
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

beforeEach(async () => {
  db = await createMemoryDb();
  await migrate(db);
  await repo.kvSet(db, 'wa_status', { state: 'conectado' });
  answer = vi.fn(async () => {});
  app = createHubApp({ db, config, answerEscalation: answer as any });
});

describe('hub', () => {
  it('auth: 401 sin credenciales, 200 con, /health libre', async () => {
    expect((await app.request('/')).status).toBe(401);
    expect((await app.request('/', { headers: { Authorization: 'Basic ' + Buffer.from('lauri:mal').toString('base64') } })).status).toBe(401);
    expect((await app.request('/', { headers: auth })).status).toBe(200);
    const h = await app.request('/health');
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('ok');
  });

  it('métricas y orden por atención', async () => {
    await repo.insertProspect(db, { name: 'Normal Uno', city: 'Rosario', waId: '5491100000001', status: 'contactado', contactedAt: new Date(), lastInboundAt: new Date() });
    await repo.insertProspect(db, { name: 'Atento Dos', waId: '5491100000002', status: 'conversando', contactedAt: new Date(), needsAttention: 'pregunta' });
    await repo.insertProspect(db, { name: 'Nuevo Tres', waId: '5491100000003' });
    const html = await (await app.request('/', { headers: auth })).text();
    expect(html).toMatch(/<b>3<\/b>\s*<span>Encontrados/);
    expect(html).toMatch(/<b>2<\/b>\s*<span>Contactados/);
    expect(html).toContain('1 (50%)');
    expect(html.indexOf('Atento Dos')).toBeLessThan(html.indexOf('Normal Uno'));
    expect(html).toContain('Conversando');
  });

  it('/p/:id muestra el chat (escapado) y el formulario de escalación', async () => {
    const p = (await repo.insertProspect(db, { name: 'Ana', waId: '5491100000001', evaluation: { stage: 'interesada', summary: 'Quiere precio' } }))!;
    await repo.addMessage(db, { prospectId: p.id, direction: 'in', author: 'prospect', body: 'hola <script>x</script>' });
    await repo.addMessage(db, { prospectId: p.id, direction: 'out', author: 'agent', body: 'Buenas!' });
    const esc = await repo.createEscalation(db, p.id, '¿Cuánto sale?');
    const html = await (await app.request(`/p/${p.id}`, { headers: auth })).text();
    expect(html).toContain('Buenas!');
    expect(html).toContain('hola &lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('Quiere precio');
    expect(html).toContain(`/escalations/${esc}/answer`);
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it('POST answer llama answerEscalation y redirige; error -> banner', async () => {
    const p = (await repo.insertProspect(db, { name: 'Ana', waId: '5491100000001' }))!;
    const esc = await repo.createEscalation(db, p.id, 'q');
    const r = await app.request(`/escalations/${esc}/answer`, form({ answer: 'Sale 10' }));
    expect(answer).toHaveBeenCalledWith(esc, 'Sale 10');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`/p/${p.id}`);

    answer.mockRejectedValueOnce(new Error('todos fallaron'));
    const r2 = await app.request(`/escalations/${esc}/answer`, form({ answer: 'x' }));
    expect(r2.status).toBe(302);
    const loc = r2.headers.get('location')!;
    expect(loc).toContain(`/p/${p.id}?error=`);
    const html = await (await app.request(loc, { headers: auth })).text();
    expect(html).toContain('No se pudo enviar la respuesta');
  });

  it('aprobar apertura_nueva crea variante candidata; doble click no da 500', async () => {
    const id = await repo.addProposal(db, { kind: 'apertura_nueva', summary: 'S', evidence: 'E', proposedContent: 'Hola {nombre} nuevo' });
    const r = await app.request(`/proposals/${id}/approve`, form({}));
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/mejoras');
    expect((await repo.listVariants(db, 'candidata')).map((v) => v.template)).toContain('Hola {nombre} nuevo');
    const r2 = await app.request(`/proposals/${id}/approve`, form({}));
    expect(r2.status).toBe(302);
    expect(r2.headers.get('location')).toContain('/mejoras?error=');
  });

  it('/mejoras lista pendientes y rechazo', async () => {
    const id = await repo.addProposal(db, { kind: 'manual', summary: 'Resumen X', evidence: 'Evid Y', proposedContent: 'Contenido Z' });
    const html = await (await app.request('/mejoras', { headers: auth })).text();
    expect(html).toContain('Resumen X');
    expect(html).toContain('Contenido Z');
    expect(html).toContain(`/proposals/${id}/reject`);
    const r = await app.request(`/proposals/${id}/reject`, form({}));
    expect(r.headers.get('location')).toBe('/mejoras');
    expect((await repo.getProposal(db, id))!.status).toBe('rechazada');
  });

  it('dncMode off -> advertencia', async () => {
    const off = createHubApp({ db, config: { ...config, dncMode: 'off' }, answerEscalation: answer as any });
    const html = await (await off.request('/', { headers: auth })).text();
    expect(html).toContain('No Llame');
  });

  it('/sistema muestra el QR como imagen', async () => {
    await repo.kvSet(db, 'wa_status', { state: 'qr', qr: 'abc' });
    const html = await (await app.request('/sistema', { headers: auth })).text();
    expect(html).toContain('<img');
    expect(html).toContain('data:image/png');
  });
});
