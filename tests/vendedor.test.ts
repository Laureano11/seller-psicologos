import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { WaGateway } from '../src/whatsapp/gateway.js';
import { createFakeTransport } from '../src/whatsapp/transport.js';
import { createFakeLlm, AllProvidersFailedError, type Llm } from '../src/llm/llm.js';
import { createVendedor } from '../src/agents/vendedor/vendedor.js';
import type { VendedorDecision } from '../src/agents/vendedor/decision.js';
import type { CalendarService, MailService } from '../src/agents/agenda/google.js';
import { parseWindow } from '../src/time.js';
import type { Config } from '../src/config.js';

const OWNER = '5491100000000';
const config = {
  sendWindow: parseWindow('mon-fri 09:00-20:00'), meetingWindow: parseWindow('mon-fri 10:00-18:00'), meetingMinutes: 30,
  tz: 'America/Argentina/Buenos_Aires', ownerWaId: OWNER, ownerName: 'Lauri', followupDays: 3, closeAfterDays: 4, maxFollowups: 1,
} as Config;
const NOW = new Date('2026-11-06T15:00:00-03:00');
const DAY = 86_400_000;

let db: Db;
let gw: WaGateway;
let calls: string[];
let calendar: CalendarService;
let mail: MailService;
let sent: { to: string; subject: string; text: string }[];

const decision = (o: Partial<VendedorDecision>): VendedorDecision => ({
  action: 'responder', message: null, question: null, meeting: null,
  evaluation: { stage: 'interesado', summary: 'resumen' }, objections: [], ...o,
});
const make = (llm: Llm, withCal = true) =>
  createVendedor({ db, llm, gateway: gw, config, calendar: withCal ? calendar : undefined, mail: withCal ? mail : undefined });
const fakeObj = (d: VendedorDecision) => createFakeLlm(() => d);
const prospect = async (o: Partial<repo.Prospect> = {}) =>
  (await repo.insertProspect(db, { name: 'Ana', waId: '5491111111111', status: 'contactado', ...o }))!;
const outbox = async () => db.query<{ kind: string; body: string; prospect_id: number | null }>('SELECT * FROM outbox ORDER BY id');
const toProspect = async () => (await outbox()).filter((o) => o.kind === 'prospect');
const toSelf = async () => (await outbox()).filter((o) => o.kind === 'self');

beforeEach(async () => {
  db = await createMemoryDb();
  await migrate(db);
  gw = new WaGateway(db, createFakeTransport(), config);
  calls = [];
  sent = [];
  calendar = {
    busy: async () => [],
    createMeeting: async (m) => { calls.push(`meet:${m.email}`); return { eventId: 'ev1', meetLink: 'https://meet/x' }; },
  };
  mail = { send: async (m) => { sent.push(m); } };
});

describe('openers', () => {
  it('pickOpenerVariant elige la candidata si tiene menos prospectos', async () => {
    const a = await repo.addVariant(db, 'activa', 'activa');
    const c = await repo.addVariant(db, 'cand', 'candidata');
    for (let i = 0; i < 3; i++) await prospect({ waId: `54911000000${i}`, openerVariantId: a });
    await prospect({ waId: '5491100000099', openerVariantId: c });
    expect((await make(fakeObj(decision({}))).pickOpenerVariant()).id).toBe(c);
  });

  it('startConversation encola, marca contactado y guarda la variante', async () => {
    const a = await repo.addVariant(db, 'Hola {nombre}', 'activa');
    const p = await prospect({ status: 'encontrado' });
    await make(createFakeLlm(() => 'Hola Ana, soy Lauri')).startConversation(p.id, NOW);
    expect((await toProspect()).map((o) => o.body)).toEqual(['Hola Ana, soy Lauri']);
    const u = (await repo.getProspect(db, p.id))!;
    expect(u.status).toBe('contactado');
    expect(u.openerVariantId).toBe(a);
    expect(u.contactedAt).toEqual(NOW);
  });
});

describe('handleInbound', () => {
  it('responder -> conversando y encola el mensaje; guarda evaluación y objeciones', async () => {
    const p = await prospect();
    await repo.addMessage(db, { prospectId: p.id, direction: 'in', author: 'prospect', body: 'hola' });
    await make(fakeObj(decision({ message: 'Hola!', objections: ['precio', 'precio'] }))).handleInbound(p.id, NOW);
    expect((await toProspect()).map((o) => o.body)).toEqual(['Hola!']);
    const u = (await repo.getProspect(db, p.id))!;
    expect(u.status).toBe('conversando');
    expect(u.evaluation).toMatchObject({ stage: 'interesado' });
    expect(u.tags).toMatchObject({ objections: ['precio'], last_action: 'responder' });
  });

  it('no hace nada si está handed_off', async () => {
    const p = await prospect({ handedOff: true });
    await make(fakeObj(decision({ message: 'Hola!' }))).handleInbound(p.id, NOW);
    expect(await outbox()).toHaveLength(0);
  });

  it('responder sin mensaje no encola nada', async () => {
    const p = await prospect();
    await make(fakeObj(decision({ message: '  ' }))).handleInbound(p.id, NOW);
    expect(await outbox()).toHaveLength(0);
  });

  it('escalar_pregunta -> escalación, needs_attention y aviso al dueño', async () => {
    const p = await prospect();
    await make(fakeObj(decision({ action: 'escalar_pregunta', question: '¿Cuánto sale?', message: 'Lo consulto y te cuento' }))).handleInbound(p.id, NOW);
    expect(await repo.listOpenEscalations(db)).toHaveLength(1);
    expect((await repo.getProspect(db, p.id))?.needsAttention).toBe('pregunta');
    expect((await toSelf()).map((o) => o.body)).toEqual(['❓ Ana pregunta: ¿Cuánto sale? — respondé en el hub']);
    expect((await toProspect()).map((o) => o.body)).toEqual(['Lo consulto y te cuento']);
  });

  it('listo_para_cerrar -> handed_off, nada al prospecto, aviso al dueño', async () => {
    const p = await prospect();
    await make(fakeObj(decision({ action: 'listo_para_cerrar', message: 'no enviar' }))).handleInbound(p.id, NOW);
    const u = (await repo.getProspect(db, p.id))!;
    expect(u).toMatchObject({ handedOff: true, status: 'listo_para_cerrar', needsAttention: 'listo_para_cerrar' });
    expect(await toProspect()).toHaveLength(0);
    expect((await toSelf()).map((o) => o.body)).toEqual(['✅ Ana está listo para cerrar. Resumen: resumen']);
  });

  it('sospecha_bot -> handed_off, nada al prospecto', async () => {
    const p = await prospect();
    await make(fakeObj(decision({ action: 'sospecha_bot', message: 'no enviar' }))).handleInbound(p.id, NOW);
    expect(await repo.getProspect(db, p.id)).toMatchObject({ handedOff: true, needsAttention: 'sospecha_bot' });
    expect(await toProspect()).toHaveLength(0);
    expect((await toSelf()).map((o) => o.body)).toEqual(['⚠️ Ana sospecha que habla con un bot. Tomá la charla.']);
  });

  it('ofrecer_reunion sin calendario -> escala', async () => {
    const p = await prospect();
    await make(fakeObj(decision({ action: 'ofrecer_reunion', message: 'dale' })), false).handleInbound(p.id, NOW);
    expect((await repo.listOpenEscalations(db))[0].question).toBe('Quiere una reunión pero la agenda no está configurada');
  });

  describe('agenda', () => {
    it('ofrecer_reunion guarda slots, los lista y pasa a interesado', async () => {
      const p = await prospect();
      await make(fakeObj(decision({ action: 'ofrecer_reunion', message: 'Te paso horarios' }))).handleInbound(p.id, NOW);
      const u = (await repo.getProspect(db, p.id))!;
      expect(u.status).toBe('interesado');
      expect(u.attributes.offered_slots).toHaveLength(3);
      expect((await toProspect())[0].body).toContain('lunes 9/11 a las 10:00');
    });

    const offered = '2026-11-09T13:00:00.000Z';
    it('slot no ofrecido -> no agenda y pide el dato', async () => {
      const p = await prospect({ attributes: { offered_slots: [offered] } });
      await make(fakeObj(decision({ action: 'agendar_reunion', meeting: { slotIso: '2026-11-10T13:00:00.000Z', email: 'a@b.com' } }))).handleInbound(p.id, NOW);
      expect(calls).toEqual([]);
      expect(await toProspect()).toHaveLength(1);
      expect((await repo.getProspect(db, p.id))?.status).toBe('contactado');
    });

    it('email inválido -> no agenda', async () => {
      const p = await prospect({ attributes: { offered_slots: [offered] } });
      await make(fakeObj(decision({ action: 'agendar_reunion', meeting: { slotIso: offered, email: 'nope' } }))).handleInbound(p.id, NOW);
      expect(calls).toEqual([]);
      expect((await toProspect())[0].body).toContain('mail');
    });

    it('slot ofrecido + email -> reunión, mail, status y aviso', async () => {
      const p = await prospect({ attributes: { offered_slots: [offered] } });
      await make(fakeObj(decision({ action: 'agendar_reunion', message: 'Listo!', meeting: { slotIso: offered, email: 'a@b.com' } }))).handleInbound(p.id, NOW);
      expect(calls).toEqual(['meet:a@b.com']);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'a@b.com', subject: 'Reunión confirmada — lunes 9/11 a las 10:00' });
      expect((await repo.getProspect(db, p.id))?.status).toBe('reunion_agendada');
      expect(await repo.listUpcomingMeetings(db, NOW)).toHaveLength(1);
      expect((await toSelf())[0].body).toBe('📅 Reunión con Ana: lunes 9/11 a las 10:00');
    });
  });

  it('baja -> opt-out', async () => {
    const p = await prospect();
    await make(fakeObj(decision({ action: 'baja', message: 'Perdón!' }))).handleInbound(p.id, NOW);
    expect(await repo.isOptedOut(db, '5491111111111')).toBe(true);
  });

  it('rechazo -> rechazado', async () => {
    const p = await prospect();
    await make(fakeObj(decision({ action: 'rechazo', message: 'Gracias' }))).handleInbound(p.id, NOW);
    expect((await repo.getProspect(db, p.id))?.status).toBe('rechazado');
  });

  it('AllProvidersFailedError -> nada en outbox y queda pendiente (sin duplicar)', async () => {
    const p = await prospect();
    const v = make(createFakeLlm(() => { throw new AllProvidersFailedError('x', []); }));
    await v.handleInbound(p.id, NOW);
    await v.handleInbound(p.id, NOW);
    expect(await outbox()).toHaveLength(0);
    expect(await repo.kvGet<number[]>(db, 'pending_inbound')).toEqual([p.id]);
  });
});

describe('answerEscalation', () => {
  it('guarda FAQ, encola la respuesta y limpia needs_attention', async () => {
    const p = await prospect({ needsAttention: 'pregunta' });
    const id = await repo.createEscalation(db, p.id, '¿Cuánto sale?');
    await make(createFakeLlm(() => 'Sale 10 lucas')).answerEscalation(id, '10 lucas');
    expect(await repo.listFaq(db)).toMatchObject([{ question: '¿Cuánto sale?', answer: '10 lucas' }]);
    expect((await toProspect()).map((o) => o.body)).toEqual(['Sale 10 lucas']);
    expect((await repo.getProspect(db, p.id))?.needsAttention).toBeNull();
    expect((await repo.getEscalation(db, id))?.status).toBe('respondida');
  });
});

describe('runFollowups', () => {
  it('contactado hace 4 días sin respuesta -> 1 seguimiento', async () => {
    const p = await prospect({ lastOutboundAt: new Date(NOW.getTime() - 4 * DAY) });
    const n = await make(createFakeLlm(() => '¿Pudiste verlo?')).runFollowups(NOW);
    expect(n).toBe(1);
    expect((await toProspect()).map((o) => o.body)).toEqual(['¿Pudiste verlo?']);
    expect((await repo.getProspect(db, p.id))?.followupsSent).toBe(1);
  });

  it('seguimiento agotado hace 5 días -> sin_respuesta', async () => {
    const p = await prospect({ followupsSent: 1, lastOutboundAt: new Date(NOW.getTime() - 5 * DAY) });
    expect(await make(createFakeLlm(() => 'x')).runFollowups(NOW)).toBe(0);
    expect(await outbox()).toHaveLength(0);
    expect((await repo.getProspect(db, p.id))?.status).toBe('sin_respuesta');
  });
});
