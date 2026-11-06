import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { WaGateway } from '../src/whatsapp/gateway.js';
import { createFakeTransport, type FakeTransport, type IncomingMsg } from '../src/whatsapp/transport.js';
import { createOrchestrator } from '../src/orchestrator/orchestrator.js';
import { parseWindow } from '../src/time.js';
import type { Config } from '../src/config.js';

const OWNER = '5491100000000';
const config = {
  sendWindow: parseWindow('mon-fri 09:00-20:00'), tz: 'America/Argentina/Buenos_Aires', ownerWaId: OWNER,
  dailyNewContacts: 5, searchHour: 9, replyDebounceSeconds: 30,
} as Config;
// hora Argentina = UTC-3. 2026-11-06 viernes, 11-08 domingo, 11-09 lunes.
const FRI_NOON = new Date('2026-11-06T15:00:00Z');
const SUNDAY = new Date('2026-11-08T15:00:00Z');
const MON_905 = new Date('2026-11-09T12:05:00Z');
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const MIN = 60_000;

let db: Db;
let tr: FakeTransport;
let gw: WaGateway;
let vendedor: { handleInbound: ReturnType<typeof vi.fn>; startConversation: ReturnType<typeof vi.fn>; runFollowups: ReturnType<typeof vi.fn> };
let runBuscador: Mock<(now: Date) => Promise<unknown>>;
let runWeeklyAnalysis: Mock<(now: Date) => Promise<unknown>>;
let orch: ReturnType<typeof createOrchestrator>;

const selfMsgs = async () =>
  (await db.query<{ body: string }>("SELECT body FROM outbox WHERE kind='self' ORDER BY id")).map((r) => r.body);
const contactedAt = (i: number, at: Date) =>
  repo.insertProspect(db, { name: `P${i}`, waId: `54911000000${i}`, status: 'contactado', contactedAt: at });

beforeEach(async () => {
  db = await createMemoryDb();
  await migrate(db);
  tr = createFakeTransport();
  gw = new WaGateway(db, tr, config);
  vendedor = {
    handleInbound: vi.fn(async () => {}),
    startConversation: vi.fn(async (id: number, now: Date) => {
      await repo.updateProspect(db, id, { status: 'contactado', contactedAt: now });
    }),
    runFollowups: vi.fn(async () => 0),
  };
  runBuscador = vi.fn(async () => ({}));
  runWeeklyAnalysis = vi.fn(async () => ({}));
  orch = createOrchestrator({ db, config, gateway: gw, vendedor: vendedor as any, runBuscador, runWeeklyAnalysis });
});

describe('debounce', () => {
  it('tres mensajes seguidos -> una sola respuesta tras la pausa', async () => {
    const p = (await repo.insertProspect(db, { name: 'Ana', waId: '5491111111111', status: 'contactado' }))!;
    const m = (id: string): IncomingMsg => ({ fromWaId: '5491111111111', text: 'hola', id, at: FRI_NOON, fromMe: false });
    await orch.onIncoming(m('a'), FRI_NOON);
    await orch.onIncoming(m('b'), plus(FRI_NOON, 5_000));
    await orch.onIncoming(m('c'), plus(FRI_NOON, 10_000));
    await orch.runDue(plus(FRI_NOON, 20_000));
    expect(vendedor.handleInbound).not.toHaveBeenCalled(); // la última reprogramó a +40s
    await orch.runDue(plus(FRI_NOON, 41_000));
    expect(vendedor.handleInbound).toHaveBeenCalledTimes(1);
    expect(vendedor.handleInbound).toHaveBeenCalledWith(p.id, plus(FRI_NOON, 41_000));
    await orch.runDue(plus(FRI_NOON, 120_000));
    expect(vendedor.handleInbound).toHaveBeenCalledTimes(1);
  });

  it('mensaje de número desconocido no programa nada', async () => {
    await orch.onIncoming({ fromWaId: '5492222222222', text: 'hola', id: 'x', at: FRI_NOON, fromMe: false }, FRI_NOON);
    await orch.runDue(plus(FRI_NOON, 60_000));
    expect(vendedor.handleInbound).not.toHaveBeenCalled();
  });
});

describe('tick', () => {
  it('buscador: una vez por día', async () => {
    await orch.tick(MON_905);
    await orch.tick(plus(MON_905, MIN));
    expect(runBuscador).toHaveBeenCalledTimes(1);
  });

  it('buscador: no corre antes de la hora de búsqueda', async () => {
    await orch.tick(new Date('2026-11-09T11:30:00Z')); // 08:30 local
    expect(runBuscador).not.toHaveBeenCalled();
  });

  it('análisis semanal: lunes, una vez por semana', async () => {
    await orch.tick(MON_905);
    await orch.tick(plus(MON_905, MIN));
    expect(runWeeklyAnalysis).toHaveBeenCalledTimes(1);
    await orch.tick(FRI_NOON);
    expect(runWeeklyAnalysis).toHaveBeenCalledTimes(1);
  });

  it('seguimientos: una vez por día desde las 10:00', async () => {
    await orch.tick(MON_905);
    expect(vendedor.runFollowups).not.toHaveBeenCalled();
    await orch.tick(plus(MON_905, 60 * MIN));
    await orch.tick(plus(MON_905, 61 * MIN));
    expect(vendedor.runFollowups).toHaveBeenCalledTimes(1);
  });

  it('con 5 contactados hoy no inicia otro', async () => {
    await repo.insertProspect(db, { name: 'Nuevo', waId: '5491199999999', status: 'encontrado' });
    for (let i = 1; i <= 5; i++) await contactedAt(i, plus(FRI_NOON, -(i + 60) * MIN));
    await orch.tick(FRI_NOON);
    expect(vendedor.startConversation).not.toHaveBeenCalled();
  });

  it('con 2 contactados y el último hace 40 min inicia uno; con 10 min no', async () => {
    const nuevo = (await repo.insertProspect(db, { name: 'Nuevo', waId: '5491199999999', status: 'encontrado' }))!;
    await contactedAt(1, plus(FRI_NOON, -100 * MIN));
    await contactedAt(2, plus(FRI_NOON, -40 * MIN));
    await repo.kvSet(db, 'last_new_contact_at', plus(FRI_NOON, -10 * MIN).toISOString());
    await orch.tick(FRI_NOON);
    expect(vendedor.startConversation).not.toHaveBeenCalled();
    await repo.kvSet(db, 'last_new_contact_at', plus(FRI_NOON, -40 * MIN).toISOString());
    await orch.tick(plus(FRI_NOON, MIN));
    expect(vendedor.startConversation).toHaveBeenCalledTimes(1);
    expect(vendedor.startConversation).toHaveBeenCalledWith(nuevo.id, plus(FRI_NOON, MIN));
    // el siguiente tick queda frenado por el espaciado de 30 min
    await repo.insertProspect(db, { name: 'Otro', waId: '5491188888888', status: 'encontrado' });
    await orch.tick(plus(FRI_NOON, 2 * MIN));
    expect(vendedor.startConversation).toHaveBeenCalledTimes(1);
  });

  it('domingo no inicia contactos nuevos', async () => {
    await repo.insertProspect(db, { name: 'Nuevo', waId: '5491199999999', status: 'encontrado' });
    await orch.tick(SUNDAY);
    expect(vendedor.startConversation).not.toHaveBeenCalled();
  });

  it('3 bajas en 7 días -> pausa_nuevos, aviso al dueño y no inicia contactos', async () => {
    await repo.insertProspect(db, { name: 'Nuevo', waId: '5491199999999', status: 'encontrado' });
    for (let i = 1; i <= 3; i++) {
      await db.query('INSERT INTO opt_outs (wa_id, reason, created_at) VALUES ($1,$2,$3)', [`5491100000${i}00`, 'x', plus(FRI_NOON, -i * 24 * 60 * MIN)]);
    }
    await orch.tick(FRI_NOON);
    expect(await repo.kvGet(db, 'pausa_nuevos')).toMatchObject({ since: FRI_NOON.toISOString() });
    expect(await selfMsgs()).toEqual(['⛔ Pausé los contactos nuevos: hubo 3 bajas en los últimos 7 días. Revisalo en el hub.']);
    expect(vendedor.startConversation).not.toHaveBeenCalled();
    await orch.tick(plus(FRI_NOON, 31 * MIN));
    expect(vendedor.startConversation).not.toHaveBeenCalled();
    expect(await selfMsgs()).toHaveLength(1);
  });

  it('un paso que lanza no frena los demás (flush corre) y se loguea', async () => {
    runBuscador.mockRejectedValue(new Error('boom'));
    const flush = vi.spyOn(gw, 'flushOutbox');
    await orch.tick(MON_905);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(runWeeklyAnalysis).toHaveBeenCalledTimes(1);
    const ev = (await repo.listEvents(db, 10)).find((e) => e.type === 'error');
    expect(ev?.payload).toMatchObject({ paso: 'buscador', mensaje: 'boom' });
  });

  it('3 fallos seguidos del mismo paso -> un solo aviso; se rearma tras recuperarse', async () => {
    runBuscador.mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 4; i++) await orch.tick(plus(MON_905, i * 31 * MIN));
    expect(await selfMsgs()).toEqual(['⚠️ El paso buscador falló 3 veces seguidas: boom']);
    runBuscador.mockResolvedValue({});
    await orch.tick(plus(MON_905, 5 * 31 * MIN)); // recupera
    runBuscador.mockRejectedValue(new Error('otra'));
    await orch.tick(new Date('2026-11-10T12:00:00Z'));
    await orch.tick(new Date('2026-11-10T12:31:00Z'));
    await orch.tick(new Date('2026-11-10T13:02:00Z'));
    expect(await selfMsgs()).toHaveLength(2);
  });

  it('reintentos: saca el id de pending_inbound antes de llamar y respeta el máximo de 5', async () => {
    await repo.kvSet(db, 'pending_inbound', [1, 2, 3, 4, 5, 6, 7]);
    const seen: unknown[] = [];
    vendedor.handleInbound.mockImplementation(async (id: number) => {
      seen.push([id, await repo.kvGet(db, 'pending_inbound')]);
    });
    await orch.tick(FRI_NOON);
    expect(vendedor.handleInbound).toHaveBeenCalledTimes(5);
    expect(seen[0]).toEqual([1, [6, 7]]);
    expect(await repo.kvGet(db, 'pending_inbound')).toEqual([6, 7]);
  });

  it('reintentos: si handleInbound lanza, el id vuelve a pending_inbound y los demás se procesan', async () => {
    await repo.kvSet(db, 'pending_inbound', [1, 2, 3]);
    vendedor.handleInbound.mockImplementation(async (id: number) => { if (id === 1) throw new Error('x'); });
    await orch.tick(FRI_NOON);
    expect(vendedor.handleInbound).toHaveBeenCalledTimes(3);
    expect(await repo.kvGet(db, 'pending_inbound')).toEqual([1]);
  });

  it('runDue: si handleInbound lanza, el prospecto queda en pending_inbound y cuenta como fallo de responder', async () => {
    const p = (await repo.insertProspect(db, { name: 'Ana', waId: '5491111111111', status: 'contactado' }))!;
    vendedor.handleInbound.mockRejectedValue(new Error('llm caído'));
    const m = (id: string): IncomingMsg => ({ fromWaId: '5491111111111', text: 'hola', id, at: FRI_NOON, fromMe: false });
    await orch.onIncoming(m('a'), FRI_NOON);
    await orch.tick(plus(FRI_NOON, 31_000));
    expect((await repo.kvGet<number[]>(db, 'pending_inbound'))).toContain(p.id);
    expect((await repo.listEvents(db, 10)).find((e) => e.payload?.paso === 'responder')?.payload).toMatchObject({ mensaje: 'llm caído' });
    // los reintentos siguen fallando: 3 ticks seguidos -> aviso (una vez)
    await orch.tick(plus(FRI_NOON, 2 * MIN));
    await orch.tick(plus(FRI_NOON, 3 * MIN));
    await orch.tick(plus(FRI_NOON, 4 * MIN));
    expect((await selfMsgs()).filter((b) => b.includes('reintentos'))).toHaveLength(1);
  });

  it('buscador que falla de forma permanente se reintenta como mucho cada 30 min', async () => {
    runBuscador.mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 10; i++) await orch.tick(plus(MON_905, i * MIN));
    expect(runBuscador).toHaveBeenCalledTimes(1);
    await orch.tick(plus(MON_905, 31 * MIN));
    expect(runBuscador).toHaveBeenCalledTimes(2);
  });

  it('idle(): resuelve recién cuando termina el tick en curso, aunque otro tick se solape', async () => {
    let release!: () => void;
    runBuscador.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const first = orch.tick(MON_905);
    await vi.waitFor(() => expect(runBuscador).toHaveBeenCalled());
    await orch.tick(plus(MON_905, MIN)); // solapado
    let idle = false;
    const w = orch.idle().then(() => { idle = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(idle).toBe(false);
    release();
    await first;
    await w;
    expect(idle).toBe(true);
  });

  it('single-flight: un tick durante otro en curso retorna de inmediato', async () => {
    let release!: () => void;
    runBuscador.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const flush = vi.spyOn(gw, 'flushOutbox');
    const first = orch.tick(MON_905);
    await vi.waitFor(() => expect(runBuscador).toHaveBeenCalled());
    await orch.tick(plus(MON_905, MIN)); // resuelve ya, sin ejecutar nada
    expect(flush).not.toHaveBeenCalled();
    release();
    await first;
    expect(flush).toHaveBeenCalledTimes(1);
    await orch.tick(plus(MON_905, 2 * MIN)); // ya libre
    expect(flush).toHaveBeenCalledTimes(2);
  });
});

describe('onWaStatus', () => {
  it('guarda el estado y loguea wa_desconectado una vez tras 10 min', async () => {
    await orch.onWaStatus({ state: 'desconectado' }, FRI_NOON);
    expect(await repo.kvGet(db, 'wa_status')).toEqual({ state: 'desconectado' });
    await orch.tick(plus(FRI_NOON, 5 * MIN));
    await orch.tick(plus(FRI_NOON, 11 * MIN));
    await orch.tick(plus(FRI_NOON, 12 * MIN));
    expect((await repo.listEvents(db, 50)).filter((e) => e.type === 'wa_desconectado')).toHaveLength(1);
  });

  it('si reconecta antes de 10 min no loguea; sesion_cerrada loguea de inmediato', async () => {
    await orch.onWaStatus({ state: 'desconectado' }, FRI_NOON);
    await orch.onWaStatus({ state: 'conectado' }, plus(FRI_NOON, 2 * MIN));
    await orch.tick(plus(FRI_NOON, 20 * MIN));
    expect((await repo.listEvents(db, 50)).filter((e) => e.type === 'wa_desconectado')).toHaveLength(0);
    await orch.onWaStatus({ state: 'sesion_cerrada' }, plus(FRI_NOON, 21 * MIN));
    expect((await repo.listEvents(db, 50)).some((e) => e.type === 'wa_sesion_cerrada')).toBe(true);
  });
});
