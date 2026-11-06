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
  await repo.kvSet(db, 'wa_status', { state: 'conectado' });
  tr = createFakeTransport();
  gw = new WaGateway(db, tr, config);
});

afterEach(async () => {
  vi.useRealTimers();
  await db.close();
});

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
    let echo: Promise<unknown> | undefined;
    tr.onSend = (id) => { echo = gw.handleIncoming(msg({ fromMe: true, id, text: 'hola' })); };
    // el envío tarda en resolver: el eco se procesa antes de que el gateway conozca el id
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    tr.send = async (w, t) => { const id = await orig(w, t); await gate; return id; };
    const flushing = gw.flushOutbox(WEEKDAY);
    await vi.waitFor(() => expect(echo).toBeDefined(), { timeout: 10_000 });
    release();
    await flushing;
    await echo;
    expect((await repo.getProspect(db, p.id))?.handedOff).toBe(false);
    expect((await repo.listMessages(db, p.id)).every((m) => m.author !== 'lauri')).toBe(true);
  });
});

describe('dedupe de reentregas', () => {
  it('mismo mensaje entrante dos veces -> segundo null, una sola fila', async () => {
    const p = await prospect();
    expect(await gw.handleIncoming(msg())).toEqual({ prospectId: p.id, triggerAgent: true });
    expect(await gw.handleIncoming(msg())).toBeNull();
    expect(await count()).toBe(1);
  });

  it('entregas concurrentes del mismo id -> una sola fila y un solo trigger', async () => {
    const p = await prospect();
    const rs = await Promise.all([gw.handleIncoming(msg()), gw.handleIncoming(msg())]);
    expect(rs.filter((r) => r?.triggerAgent)).toHaveLength(1);
    expect(rs.filter((r) => r === null)).toHaveLength(1);
    expect(await count()).toBe(1);
    expect(p.id).toBeTypeOf('number');
  });

  it('mismo fromMe dos veces -> una sola fila de lauri', async () => {
    const p = await prospect();
    expect(await gw.handleIncoming(msg({ fromMe: true, id: 'm-1' }))).not.toBeNull();
    expect(await gw.handleIncoming(msg({ fromMe: true, id: 'm-1' }))).toBeNull();
    expect((await repo.listMessages(db, p.id)).filter((x) => x.author === 'lauri')).toHaveLength(1);
  });
});

describe('WaGateway.flushOutbox (robustez)', () => {
  it('si markOutboxSent falla tras enviar, el siguiente flush no reenvía y reintenta el registro', async () => {
    const p = await prospect();
    let fail = true;
    const flaky: Db = {
      ...db,
      query: (sql: string, params?: unknown[]) =>
        fail && sql.includes("status='enviado'") ? Promise.reject(new Error('db caída')) : db.query(sql, params),
    } as Db;
    const gw2 = new WaGateway(flaky, tr, config);
    const oid = await gw2.enqueueToProspect(p.id, 'hola');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await gw2.flushOutbox(WEEKDAY);
    fail = false;
    await gw2.flushOutbox(WEEKDAY);
    err.mockRestore();
    expect(tr.sent).toHaveLength(1);
    expect((await db.query<{ status: string }>('SELECT status FROM outbox WHERE id=$1', [oid]))[0].status).toBe('enviado');
    expect((await repo.listMessages(db, p.id)).filter((m) => m.direction === 'out')).toHaveLength(1);
  });

  it('throw síncrono del transporte marca fallido y sigue', async () => {
    const p = await prospect();
    const a = await gw.enqueueToProspect(p.id, 'uno');
    await gw.enqueueToOwner('dos');
    const orig = tr.send;
    let first = true;
    tr.send = ((w: string, t: string) => { if (first) { first = false; throw new Error('sync'); } return orig(w, t); }) as typeof tr.send;
    expect(await gw.flushOutbox(WEEKDAY)).toBe(1);
    expect((await db.query('SELECT status, last_error, attempts FROM outbox WHERE id=$1', [a]))[0])
      .toMatchObject({ status: 'pendiente', last_error: 'sync', attempts: 1 });
  });
});

describe('WaGateway.flushOutbox', () => {
  it('falla el registro post-envío -> no se marca fallido', async () => {
    const p = await prospect();
    const flaky: Db = {
      ...db,
      query: (sql: string, params?: unknown[]) =>
        sql.includes('INSERT INTO messages') ? Promise.reject(new Error('db caída')) : db.query(sql, params),
    } as Db;
    const gw2 = new WaGateway(flaky, tr, config);
    const oid = await gw2.enqueueToProspect(p.id, 'hola');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await gw2.flushOutbox(WEEKDAY)).toBe(1);
    err.mockRestore();
    const row = (await db.query<{ status: string }>('SELECT status FROM outbox WHERE id=$1', [oid]))[0];
    expect(row.status).toBe('enviado');
  });

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

  it('error del transporte: queda pendiente con intentos, sigue con el resto y a los 5 queda fallido con evento', async () => {
    const p = await prospect();
    const a = await gw.enqueueToProspect(p.id, 'uno');
    await gw.enqueueToOwner('dos');
    let first = true;
    const orig = tr.send;
    tr.send = async (w, t) => { if (first) { first = false; throw new Error('boom'); } return orig(w, t); };
    expect(await gw.flushOutbox(WEEKDAY)).toBe(1);
    const row = async () => (await db.query('SELECT status, error, last_error, attempts FROM outbox WHERE id=$1', [a]))[0];
    expect(await row()).toMatchObject({ status: 'pendiente', last_error: 'boom', attempts: 1, error: null });
    expect(tr.sent).toEqual([{ waId: OWNER, text: 'dos' }]);
    tr.send = async () => { throw new Error('boom'); };
    for (let i = 2; i <= 4; i++) await gw.flushOutbox(WEEKDAY);
    expect(await row()).toMatchObject({ status: 'pendiente', attempts: 4 });
    expect((await repo.listEvents(db, 10)).some((e) => e.type === 'outbox_fallido')).toBe(false);
    await gw.flushOutbox(WEEKDAY);
    expect(await row()).toMatchObject({ status: 'fallido', attempts: 5, error: 'boom' });
    const ev = (await repo.listEvents(db, 10)).filter((e) => e.type === 'outbox_fallido');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ outboxId: a, prospectId: p.id, intentos: 5, error: 'boom' });
    await gw.flushOutbox(WEEKDAY); // ya no se reintenta
    expect(await row()).toMatchObject({ attempts: 5 });
  });

  it('WhatsApp no conectado: no intenta nada y deja los items pendientes', async () => {
    const p = await prospect();
    const a = await gw.enqueueToProspect(p.id, 'uno');
    await gw.enqueueToOwner('dos');
    for (const state of ['desconectado', 'qr', 'conectando', 'sesion_cerrada']) {
      await repo.kvSet(db, 'wa_status', { state });
      expect(await gw.flushOutbox(WEEKDAY)).toBe(0);
    }
    expect(tr.sent).toEqual([]);
    expect((await db.query('SELECT status, attempts FROM outbox WHERE id=$1', [a]))[0]).toMatchObject({ status: 'pendiente', attempts: 0 });
    await repo.kvSet(db, 'wa_status', { state: 'conectado' });
    expect(await gw.flushOutbox(WEEKDAY)).toBe(2);
  });
});

describe('prospecto nunca contactado (encontrado)', () => {
  it('mensaje entrante -> se guarda, handed_off y no dispara al agente', async () => {
    const p = await prospect('encontrado');
    expect(await gw.handleIncoming(msg())).toEqual({ prospectId: p.id, triggerAgent: false });
    const cur = (await repo.getProspect(db, p.id))!;
    expect(cur.handedOff).toBe(true);
    expect(cur.lastInboundAt).toEqual(WEEKDAY);
    expect(await repo.listMessages(db, p.id)).toMatchObject([{ direction: 'in', author: 'prospect', body: 'hola' }]);
  });

  it('mensaje propio (fromMe) -> handed_off', async () => {
    const p = await prospect('encontrado');
    expect(await gw.handleIncoming(msg({ fromMe: true, id: 'yo-1' }))).toEqual({ prospectId: p.id, triggerAgent: false });
    expect((await repo.getProspect(db, p.id))!.handedOff).toBe(true);
  });
});

describe('mensajes que no son texto', () => {
  it('audio del prospecto -> se guarda, no dispara al agente, escala al dueño con needs_attention', async () => {
    const p = await prospect();
    expect(await gw.handleIncoming(msg({ text: '[audio]', media: 'audio' }))).toEqual({ prospectId: p.id, triggerAgent: false });
    expect(await repo.listMessages(db, p.id)).toMatchObject([{ direction: 'in', author: 'prospect', body: '[audio]' }]);
    const cur = (await repo.getProspect(db, p.id))!;
    expect(cur.needsAttention).toBe('pregunta');
    expect(cur.lastInboundAt).toEqual(WEEKDAY);
    expect((await repo.listOpenEscalations(db)).map((e) => e.question)).toEqual(['Te mandó un audio, escuchalo en el celular']);
    const self = await db.query<{ body: string; to_wa_id: string }>("SELECT body, to_wa_id FROM outbox WHERE kind='self'");
    expect(self).toEqual([{ body: '❓ P te mandó un audio, escuchalo en el celular y respondé en el hub', to_wa_id: OWNER }]);
  });

  it('imagen -> "mirala"; reentrega no duplica la escalación', async () => {
    await prospect();
    await gw.handleIncoming(msg({ text: '[imagen]', media: 'imagen' }));
    expect(await gw.handleIncoming(msg({ text: '[imagen]', media: 'imagen' }))).toBeNull();
    expect((await repo.listOpenEscalations(db)).map((e) => e.question)).toEqual(['Te mandó una imagen, mirala en el celular']);
  });

  it('no texto de prospecto en baja o tomado -> solo se guarda', async () => {
    const p = await prospect('baja');
    expect(await gw.handleIncoming(msg({ text: '[audio]', media: 'audio' }))).toEqual({ prospectId: p.id, triggerAgent: false });
    expect(await repo.listOpenEscalations(db)).toHaveLength(0);
  });

  it('no texto propio (fromMe) -> toma de control igual que el texto', async () => {
    const p = await prospect();
    expect(await gw.handleIncoming(msg({ fromMe: true, id: 'yo-audio', text: '[audio]', media: 'audio' })))
      .toEqual({ prospectId: p.id, triggerAgent: false });
    expect((await repo.getProspect(db, p.id))!.handedOff).toBe(true);
    expect(await repo.listMessages(db, p.id)).toMatchObject([{ author: 'lauri', body: '[audio]' }]);
    expect(await repo.listOpenEscalations(db)).toHaveLength(0);
  });
});
