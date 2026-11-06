import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { WaGateway } from '../src/whatsapp/gateway.js';
import { createFakeTransport, type FakeTransport, type IncomingMsg } from '../src/whatsapp/transport.js';
import { parseWindow } from '../src/time.js';
import type { Config } from '../src/config.js';

const OWNER = '5491100000000';
const P_WA = '5491111111111';
const config = { sendWindow: parseWindow('mon-fri 09:00-20:00'), tz: 'America/Argentina/Buenos_Aires', ownerWaId: OWNER } as Config;
// 2026-11-06 es viernes; 2026-11-08 domingo (hora Argentina = UTC-3)
const WEEKDAY = new Date('2026-11-06T15:00:00Z');
const SUNDAY = new Date('2026-11-08T15:00:00Z');

let db: Db;
let tr: FakeTransport;
let gw: WaGateway;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-06T14:00:00Z') });
  db = await createMemoryDb();
  await migrate(db);
  tr = createFakeTransport();
  gw = new WaGateway(db, tr, config);
});

afterEach(() => vi.useRealTimers());

const prospect = async (status: repo.Status = 'contactado', waId = P_WA) =>
  (await repo.insertProspect(db, { name: 'P', waId, status }))!;
const msg = (o: Partial<IncomingMsg> = {}): IncomingMsg => ({ fromWaId: P_WA, text: 'hola', id: 'in-1', at: WEEKDAY, fromMe: false, ...o });
const count = async () => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM messages'))[0].n;

describe('WaGateway.handleIncoming', () => {
  it('número que no es prospecto -> null y no guarda nada', async () => {
    expect(await gw.handleIncoming(msg({ fromWaId: '5492222222222' }))).toBeNull();
    expect(await count()).toBe(0);
  });

  it('fromMe a número que no es prospecto -> null', async () => {
    expect(await gw.handleIncoming(msg({ fromWaId: '5492222222222', fromMe: true }))).toBeNull();
    expect(await count()).toBe(0);
  });

  it('chat propio del dueño -> null', async () => {
    await prospect('contactado', OWNER);
    expect(await gw.handleIncoming(msg({ fromWaId: OWNER }))).toBeNull();
    expect(await count()).toBe(0);
  });

  it('mensaje de prospecto contactado -> guardado y triggerAgent', async () => {
    const p = await prospect();
    expect(await gw.handleIncoming(msg())).toEqual({ prospectId: p.id, triggerAgent: true });
    const ms = await repo.listMessages(db, p.id);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ direction: 'in', author: 'prospect', body: 'hola', waMessageId: 'in-1' });
    expect((await repo.getProspect(db, p.id))?.lastInboundAt).toEqual(WEEKDAY);
  });

  it('mensaje de prospecto en baja -> guardado pero sin triggerAgent', async () => {
    const p = await prospect('baja');
    expect(await gw.handleIncoming(msg())).toEqual({ prospectId: p.id, triggerAgent: false });
  });

  it('fromMe con id desconocido -> toma de control manual y flush no envía', async () => {
    const p = await prospect();
    expect(await gw.handleIncoming(msg({ fromMe: true, id: 'manual-1', text: 'hola, soy Lauri' }))).toEqual({ prospectId: p.id, triggerAgent: false });
    expect((await repo.getProspect(db, p.id))?.handedOff).toBe(true);
    const ms = await repo.listMessages(db, p.id);
    expect(ms[0]).toMatchObject({ direction: 'out', author: 'lauri' });
    const oid = await gw.enqueueToProspect(p.id, 'hola');
    expect(await gw.flushOutbox(WEEKDAY)).toBe(0);
    expect(tr.sent).toEqual([]);
    const row = (await db.query<{ status: string; error: string }>('SELECT status, error FROM outbox WHERE id=$1', [oid]))[0];
    expect(row).toMatchObject({ status: 'fallido', error: 'bloqueado' });
  });

  it('fromMe con id de un envío del sistema no es toma de control', async () => {
    const p = await prospect();
    await gw.enqueueToProspect(p.id, 'hola');
    await gw.flushOutbox(WEEKDAY);
    expect(await gw.handleIncoming(msg({ fromMe: true, id: 'fake-1', text: 'hola' }))).toBeNull();
    expect((await repo.getProspect(db, p.id))?.handedOff).toBe(false);
  });

  it('eco fromMe que llega antes de markOutboxSent tampoco es toma de control', async () => {
    const p = await prospect();
    await gw.enqueueToProspect(p.id, 'hola');
    const orig = tr.send;
    tr.onSend = (id) => { void gw.handleIncoming(msg({ fromMe: true, id, text: 'hola' })); };
    // el envío tarda en resolver: el eco se procesa antes de que el gateway conozca el id
    tr.send = async (w, t) => { const id = await orig(w, t); await new Promise((r) => setTimeout(r, 100)); return id; };
    await gw.flushOutbox(WEEKDAY);
    await new Promise((r) => setTimeout(r, 50));
    expect((await repo.getProspect(db, p.id))?.handedOff).toBe(false);
    expect((await repo.listMessages(db, p.id)).every((m) => m.author !== 'lauri')).toBe(true);
  });
});

describe('WaGateway.flushOutbox', () => {
  it('no envía a prospecto en baja', async () => {
    const p = await prospect('baja');
    await gw.enqueueToProspect(p.id, 'hola');
    expect(await gw.flushOutbox(WEEKDAY)).toBe(0);
    expect(tr.sent).toEqual([]);
  });

  it('no envía a prospecto en opt-out', async () => {
    const p = await prospect();
    await db.query('INSERT INTO opt_outs (wa_id, reason) VALUES ($1,$2)', [P_WA, 'x']);
    await gw.enqueueToProspect(p.id, 'hola');
    expect(await gw.flushOutbox(WEEKDAY)).toBe(0);
    expect(tr.sent).toEqual([]);
  });

  it('fuera de ventana queda pendiente; dentro se envía y registra mensaje out', async () => {
    const p = await prospect();
    await gw.enqueueToProspect(p.id, 'hola');
    expect(await gw.flushOutbox(SUNDAY)).toBe(0);
    expect(tr.sent).toEqual([]);
    expect((await repo.dueOutbox(db, SUNDAY))).toHaveLength(1);
    expect(await gw.flushOutbox(WEEKDAY)).toBe(1);
    expect(tr.sent).toEqual([{ waId: P_WA, text: 'hola' }]);
    const ms = await repo.listMessages(db, p.id);
    expect(ms[0]).toMatchObject({ direction: 'out', author: 'agent', body: 'hola', waMessageId: 'fake-1' });
    expect((await repo.getProspect(db, p.id))?.lastOutboundAt).not.toBeNull();
    expect(await repo.dueOutbox(db, WEEKDAY)).toHaveLength(0);
  });

  it('enqueueToOwner se envía aunque sea domingo, al número del dueño', async () => {
    await gw.enqueueToOwner('aviso');
    expect(await gw.flushOutbox(SUNDAY)).toBe(1);
    expect(tr.sent).toEqual([{ waId: OWNER, text: 'aviso' }]);
  });

  it('error del transporte marca fallido y sigue con el resto', async () => {
    const p = await prospect();
    const a = await gw.enqueueToProspect(p.id, 'uno');
    await gw.enqueueToOwner('dos');
    let first = true;
    const orig = tr.send;
    tr.send = async (w, t) => { if (first) { first = false; throw new Error('boom'); } return orig(w, t); };
    expect(await gw.flushOutbox(WEEKDAY)).toBe(1);
    const row = (await db.query<{ status: string; error: string }>('SELECT status, error FROM outbox WHERE id=$1', [a]))[0];
    expect(row).toMatchObject({ status: 'fallido', error: 'boom' });
    expect(tr.sent).toEqual([{ waId: OWNER, text: 'dos' }]);
  });
});
