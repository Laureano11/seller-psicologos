import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { seedKnowledge } from '../src/db/repo.js';

let db: Db;
beforeEach(async () => {
  db = await createMemoryDb();
  await migrate(db);
});

const mk = (name: string, waId: string | null) => repo.insertProspect(db, { name, waId, phoneRaw: waId ?? undefined, email: 'a@b.c' });

describe('repo', () => {
  it('migrate es idempotente', async () => {
    await migrate(db);
  });

  it('insertProspect duplicado por wa_id -> null', async () => {
    const a = await mk('A', '5491111111111');
    expect(a?.id).toBeTypeOf('number');
    expect(a?.status).toBe('encontrado');
    expect(a?.profileUrls).toEqual([]);
    expect(a?.tags).toEqual({ objections: [] });
    expect(await mk('B', '5491111111111')).toBeNull();
    expect((await repo.getProspectByWaId(db, '5491111111111'))?.name).toBe('A');
  });

  it('updateProspect y setStatus', async () => {
    const a = (await mk('A', '5491111111111'))!;
    const u = await repo.updateProspect(db, a.id, { city: 'Rosario', tags: { objections: ['precio'] }, followupsSent: 1 });
    expect(u?.city).toBe('Rosario');
    expect(u?.tags).toEqual({ objections: ['precio'] });
    await repo.setStatus(db, a.id, 'interesado', 'respondió');
    const g = await repo.getProspect(db, a.id);
    expect(g?.status).toBe('interesado');
    expect(g?.statusReason).toBe('respondió');
  });

  it('applyOptOut anonimiza', async () => {
    const a = (await mk('A', '5491111111111'))!;
    await repo.addMessage(db, { prospectId: a.id, direction: 'in', author: 'prospect', body: 'no gracias' });
    await repo.applyOptOut(db, a.id, 'pidió baja');
    expect(await repo.isOptedOut(db, '5491111111111')).toBe(true);
    const p = (await repo.getProspect(db, a.id))!;
    expect(p.status).toBe('baja');
    expect(p.name).toBe('(baja)');
    expect(p.email).toBeNull();
    expect(await repo.listMessages(db, a.id)).toEqual([]);
  });

  it('pickContactable excluye opt-outs, sin wa_id y otros estados; más antiguos primero', async () => {
    const a = (await mk('A', '5491111111111'))!;
    const b = (await mk('B', '5491122222222'))!;
    await mk('C', null);
    const d = (await mk('D', '5491133333333'))!;
    const e = (await mk('E', '5491144444444'))!;
    await db.query('INSERT INTO opt_outs (wa_id, reason) VALUES ($1,$2)', ['5491122222222', 'dnc']);
    await repo.setStatus(db, d.id, 'contactado');
    const got = await repo.pickContactable(db, 10);
    expect(got.map((p) => p.id)).toEqual([a.id, e.id]);
    expect(await repo.pickContactable(db, 1)).toHaveLength(1);
    expect(b.id).toBeTruthy();
  });

  it('countContactedSince', async () => {
    const a = (await mk('A', '5491111111111'))!;
    await mk('B', '5491122222222');
    await repo.updateProspect(db, a.id, { contactedAt: new Date() });
    expect(await repo.countContactedSince(db, new Date(Date.now() - 3600_000))).toBe(1);
    expect(await repo.countContactedSince(db, new Date(Date.now() + 3600_000))).toBe(0);
  });

  it('listProspectsForHub ordena atención, listo_para_cerrar, updated_at', async () => {
    const a = (await mk('A', '5491111111111'))!;
    const b = (await mk('B', '5491122222222'))!;
    const c = (await mk('C', '5491133333333'))!;
    const d = (await mk('D', '5491144444444'))!;
    await repo.setStatus(db, b.id, 'listo_para_cerrar');
    await repo.updateProspect(db, c.id, { needsAttention: 'pregunta' });
    await repo.updateProspect(db, d.id, { city: 'x' });
    const ids = (await repo.listProspectsForHub(db)).map((p) => p.id);
    expect(ids).toEqual([c.id, b.id, d.id, a.id]);
  });

  it('mensajes', async () => {
    const a = (await mk('A', '5491111111111'))!;
    await repo.addMessage(db, { prospectId: a.id, direction: 'out', author: 'agent', body: 'hola', waMessageId: 'W1' });
    await repo.addMessage(db, { prospectId: a.id, direction: 'in', author: 'prospect', body: 'chau' });
    const ms = await repo.listMessages(db, a.id);
    expect(ms.map((m) => m.body)).toEqual(['hola', 'chau']);
    expect(ms[0].waMessageId).toBe('W1');
    expect(ms[0].createdAt).toBeInstanceOf(Date);
  });

  it('outbox', async () => {
    const now = new Date();
    const id1 = await repo.enqueueOutbox(db, { prospectId: null, toWaId: '5491100000000', body: 'x', kind: 'self', sendAfter: new Date(now.getTime() - 1000) });
    await repo.enqueueOutbox(db, { prospectId: null, toWaId: '5491100000000', body: 'y', kind: 'self', sendAfter: new Date(now.getTime() + 60_000) });
    const due = await repo.dueOutbox(db, now);
    expect(due.map((o) => o.id)).toEqual([id1]);
    expect(due[0].toWaId).toBe('5491100000000');
    await repo.markOutboxSent(db, id1, 'WA1');
    expect(await repo.dueOutbox(db, now)).toEqual([]);
    const id3 = await repo.enqueueOutbox(db, { prospectId: null, toWaId: '1', body: 'z', kind: 'self', sendAfter: now });
    await repo.markOutboxFailed(db, id3, 'boom');
    expect(await repo.dueOutbox(db, new Date(now.getTime() + 1000))).toEqual([]);
  });

  it('escalaciones y faq', async () => {
    const a = (await mk('A', '5491111111111'))!;
    const id = await repo.createEscalation(db, a.id, '¿precio?');
    expect((await repo.listOpenEscalations(db)).map((e) => e.id)).toEqual([id]);
    await repo.answerEscalationRow(db, id, '10 lucas');
    expect(await repo.listOpenEscalations(db)).toEqual([]);
    expect((await repo.getEscalation(db, id))?.answer).toBe('10 lucas');
    await repo.addFaq(db, 'q', 'a');
    expect(await repo.listFaq(db)).toHaveLength(1);
  });

  it('addManualVersion deja solo una activa por kind', async () => {
    await repo.addManualVersion(db, 'ventas', 'v1', 'archivo');
    await repo.addManualVersion(db, 'estilo', 'e1', 'archivo');
    await repo.addManualVersion(db, 'ventas', 'v2', 'propuesta');
    expect(await repo.getActiveManual(db, 'ventas')).toBe('v2');
    expect(await repo.getActiveManual(db, 'estilo')).toBe('e1');
    expect(await repo.getActiveManual(db, 'producto')).toBe('');
    const vs = await repo.listManualVersions(db, 'ventas');
    expect(vs).toHaveLength(2);
    expect(vs.filter((v) => v.active)).toHaveLength(1);
  });

  it('variantes y propuestas', async () => {
    const v = await repo.addVariant(db, 'Hola {nombre}', 'candidata');
    await repo.setVariantStatus(db, v, 'activa');
    expect((await repo.listVariants(db, 'activa')).map((x) => x.id)).toEqual([v]);
    expect(await repo.listVariants(db, 'retirada')).toEqual([]);
    const pid = await repo.addProposal(db, { kind: 'promover_apertura', summary: 's', evidence: 'e', proposedContent: 'c', targetId: v });
    expect((await repo.getProposal(db, pid))?.status).toBe('pendiente');
    expect(await repo.listProposals(db, 'pendiente')).toHaveLength(1);
    await repo.decideProposal(db, pid, 'aprobada');
    expect(await repo.listProposals(db, 'pendiente')).toEqual([]);
    expect((await repo.getProposal(db, pid))?.targetId).toBe(v);
  });

  it('reuniones, eventos y kv', async () => {
    const a = (await mk('A', '5491111111111'))!;
    const now = new Date('2026-11-09T12:00:00Z');
    await repo.addMeeting(db, { prospectId: a.id, startsAt: new Date('2026-11-10T13:00:00Z'), endsAt: new Date('2026-11-10T13:30:00Z') });
    await repo.addMeeting(db, { prospectId: a.id, startsAt: new Date('2026-11-01T13:00:00Z'), endsAt: new Date('2026-11-01T13:30:00Z') });
    expect(await repo.listUpcomingMeetings(db, now)).toHaveLength(1);
    await repo.logEvent(db, 'x', { a: 1 });
    await repo.logEvent(db, 'y', { b: 2 });
    const evs = await repo.listEvents(db, 1);
    expect(evs).toHaveLength(1);
    expect(evs[0].type).toBe('y');
    expect(evs[0].payload).toEqual({ b: 2 });
    expect(await repo.kvGet(db, 'k')).toBeUndefined();
    await repo.kvSet(db, 'k', { n: 1 });
    await repo.kvSet(db, 'k', { n: 2 });
    expect(await repo.kvGet(db, 'k')).toEqual({ n: 2 });
  });

  it('seedKnowledge carga 3 manuales y 1 variante activa; no duplica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'content-'));
    writeFileSync(join(dir, 'manual-ventas.md'), 'ventas');
    writeFileSync(join(dir, 'producto-crm.md'), 'producto');
    writeFileSync(join(dir, 'estilo.md'), 'estilo');
    writeFileSync(join(dir, 'apertura.md'), 'Hola, soy Lauri');
    await seedKnowledge(db, dir);
    await seedKnowledge(db, dir);
    expect(await repo.getActiveManual(db, 'ventas')).toBe('ventas');
    expect(await repo.getActiveManual(db, 'producto')).toBe('producto');
    expect(await repo.getActiveManual(db, 'estilo')).toBe('estilo');
    expect(await repo.listManualVersions(db, 'ventas')).toHaveLength(1);
    const vs = await repo.listVariants(db, 'activa');
    expect(vs).toHaveLength(1);
    expect(vs[0].template).toBe('Hola, soy Lauri');
  });
});
