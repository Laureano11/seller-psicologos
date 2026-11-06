import type { Db } from '../../db/db.js';
import type { Config } from '../../config.js';
import type { Llm, ChatMessage } from '../../llm/llm.js';
import { AllProvidersFailedError } from '../../llm/llm.js';
import type { WaGateway } from '../../whatsapp/gateway.js';
import {
  BLOCKED_STATUSES, EscalationNotOpenError, addFaq, addMeeting, answerEscalationRow, applyOptOut, claimEscalation,
  createEscalation, getEscalation, getProspect, isOptedOut, kvGet, kvSet, listMessages, listProspectsForHub,
  listVariants, logEvent, releaseEscalation, setStatus, updateProspect,
  type Prospect,
} from '../../db/repo.js';
import type { CalendarService, MailService } from '../agenda/google.js';
import { formatSlot, proposeSlots } from '../agenda/slots.js';
import { VendedorDecision, buildSystemPrompt, buildTextPrompt, prospectCard } from './decision.js';
import { loadKnowledge } from './knowledge.js';

export interface VendedorDeps {
  db: Db;
  llm: Llm;
  gateway: Pick<WaGateway, 'enqueueToProspect' | 'enqueueToOwner'>;
  calendar?: CalendarService;
  mail?: MailService;
  config: Config;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createVendedor(deps: VendedorDeps) {
  const { db, llm, gateway, calendar, mail, config } = deps;

  const say = async (prospectId: number, body: string | null | undefined) => {
    if (body && body.trim()) await gateway.enqueueToProspect(prospectId, body.trim());
  };

  async function pickOpenerVariant(): Promise<{ id: number; template: string }> {
    const candidata = (await listVariants(db, 'candidata'))[0];
    const activa = (await listVariants(db, 'activa'))[0];
    if (!candidata) {
      if (!activa) throw new Error('No hay variante de apertura activa');
      return { id: activa.id, template: activa.template };
    }
    if (!activa) return { id: candidata.id, template: candidata.template };
    const rows = await db.query<{ opener_variant_id: number; n: number }>(
      'SELECT opener_variant_id, count(*)::int AS n FROM prospects WHERE opener_variant_id = ANY($1) GROUP BY opener_variant_id',
      [[activa.id, candidata.id]],
    );
    const n = (id: number) => rows.find((r) => r.opener_variant_id === id)?.n ?? 0;
    const v = n(candidata.id) <= n(activa.id) ? candidata : activa;
    return { id: v.id, template: v.template };
  }

  /** Devuelve true si encoló el mensaje de apertura; false si no hizo nada. */
  async function startConversation(prospectId: number, now: Date): Promise<boolean> {
    const p = await getProspect(db, prospectId);
    if (!p || p.status !== 'encontrado' || p.handedOff || (p.waId && (await isOptedOut(db, p.waId)))) return false;
    const k = await loadKnowledge(db);
    const variant = await pickOpenerVariant();
    const text = await llm.text({
      agent: 'vendedor',
      system: `Sos ${config.ownerName} y escribís el primer mensaje de WhatsApp a un psicólogo para venderle un CRM.\n\nESTILO:\n${k.estilo}`,
      messages: [{
        role: 'user',
        content: `Ficha del prospecto:\n${prospectCard(p)}\n\nPlantilla de apertura (adaptala a la persona, manteniendo la idea):\n${variant.template}\n\nEscribí solo el mensaje.`,
      }],
    });
    if (!text.trim()) return false;
    await say(prospectId, text);
    await updateProspect(db, prospectId, { status: 'contactado', contactedAt: now, openerVariantId: variant.id });
    return true;
  }

  async function history(prospectId: number): Promise<ChatMessage[]> {
    return (await listMessages(db, prospectId)).map((m) => ({
      role: m.author === 'prospect' ? 'user' : 'assistant',
      content: m.body,
    }));
  }

  async function escalate(p: Prospect, question: string, message: string | null) {
    await say(p.id, message);
    await createEscalation(db, p.id, question);
    await updateProspect(db, p.id, { needsAttention: 'pregunta' });
    await gateway.enqueueToOwner(`❓ ${p.name} pregunta: ${question} — respondé en el hub`);
  }

  async function handleInbound(prospectId: number, now: Date): Promise<void> {
    const p = await getProspect(db, prospectId);
    if (!p || p.handedOff || BLOCKED_STATUSES.includes(p.status)) return;

    let d: VendedorDecision;
    try {
      const k = await loadKnowledge(db);
      d = await llm.object({
        agent: 'vendedor',
        system: buildSystemPrompt(k, p, config.ownerName, { now, tz: config.tz }),
        messages: await history(prospectId),
        schema: VendedorDecision,
      });
    } catch (e) {
      if (!(e instanceof AllProvidersFailedError)) throw e;
      await logEvent(db, 'vendedor_sin_modelo', { prospectId });
      const pending = (await kvGet<number[]>(db, 'pending_inbound')) ?? [];
      if (!pending.includes(prospectId)) await kvSet(db, 'pending_inbound', [...pending, prospectId]);
      return;
    }

    const attrs = { ...p.attributes };
    let status: Prospect['status'] | undefined;
    let optOut = false;

    switch (d.action) {
      case 'responder':
        await say(p.id, d.message);
        if (p.status === 'contactado' || p.status === 'encontrado') status = 'conversando';
        break;
      case 'escalar_pregunta':
        await escalate(p, d.question ?? 'Pregunta sin especificar', d.message);
        break;
      case 'listo_para_cerrar':
        status = 'listo_para_cerrar';
        await updateProspect(db, p.id, { handedOff: true, needsAttention: 'listo_para_cerrar' });
        await gateway.enqueueToOwner(`✅ ${p.name} está listo para cerrar. Resumen: ${d.evaluation.summary}`);
        break;
      case 'sospecha_bot':
        await updateProspect(db, p.id, { handedOff: true, needsAttention: 'sospecha_bot' });
        await gateway.enqueueToOwner(`⚠️ ${p.name} sospecha que habla con un bot. Tomá la charla.`);
        break;
      case 'ofrecer_reunion': {
        if (!calendar) {
          await escalate(p, 'Quiere una reunión pero la agenda no está configurada', d.message);
          break;
        }
        const slots = await proposeSlots(calendar, now, config);
        if (slots.length === 0) {
          await escalate(p, 'Quiere una reunión pero no hay horarios libres', d.message);
          break;
        }
        attrs.offered_slots = slots.map((s) => s.toISOString());
        const list = slots.map((s) => `- ${formatSlot(s, config.tz)}`).join('\n');
        await say(p.id, `${d.message?.trim() || 'Te propongo estos horarios:'}\n${list}`);
        status = 'interesado';
        break;
      }
      case 'agendar_reunion': {
        const offered = (Array.isArray(attrs.offered_slots) ? attrs.offered_slots : []) as string[];
        const t = d.meeting ? new Date(d.meeting.slotIso).getTime() : NaN;
        const slot = offered.find((s) => new Date(s).getTime() === t);
        if (!slot) {
          await say(p.id, '¿Cuál de los horarios que te pasé te queda mejor?');
        } else if (!d.meeting || !EMAIL_RE.test(d.meeting.email.trim())) {
          await say(p.id, '¿Me pasás tu mail para mandarte la invitación?');
        } else if (!calendar) {
          await escalate(p, 'Quiere agendar una reunión pero la agenda no está configurada', d.message);
        } else {
          const start = new Date(slot);
          const end = new Date(start.getTime() + config.meetingMinutes * 60_000);
          const email = d.meeting.email.trim();
          const { eventId, meetLink } = await calendar.createMeeting({ start, end, email, name: p.name });
          await addMeeting(db, { prospectId: p.id, startsAt: start, endsAt: end, calendarEventId: eventId, meetUrl: meetLink });
          const fecha = formatSlot(start, config.tz);
          try {
            await mail?.send({
              to: email,
              subject: `Reunión confirmada — ${fecha}`,
              text: `Hola ${p.name}, quedó confirmada nuestra reunión: ${fecha}.${meetLink ? `\nLink: ${meetLink}` : ''}\n\n${config.ownerName}`,
            });
          } catch (e) {
            await logEvent(db, 'mail_error', { prospectId: p.id, error: e instanceof Error ? e.message : String(e) });
          }
          delete attrs.offered_slots;
          await say(p.id, d.message?.trim() || `¡Listo! Te agendé para el ${fecha}. Te llega la invitación por mail.`);
          status = 'reunion_agendada';
          await gateway.enqueueToOwner(`📅 Reunión con ${p.name}: ${fecha}`);
        }
        break;
      }
      case 'baja':
        optOut = true;
        break;
      case 'rechazo':
        status = 'rechazado';
        break;
    }

    if (optOut) {
      await applyOptOut(db, p.id, 'pidió no recibir más mensajes');
      return;
    }
    const cur = await getProspect(db, p.id);
    const objections = [...new Set([...(cur?.tags.objections ?? []), ...d.objections])];
    await updateProspect(db, p.id, {
      attributes: attrs,
      evaluation: d.evaluation,
      tags: { ...cur?.tags, objections, last_action: d.action },
    });
    if (status) await setStatus(db, p.id, status);
  }

  /**
   * Toma la escalación de forma atómica antes de redactar (evita dos respuestas a la misma consulta).
   * Si ya no estaba abierta lanza EscalationNotOpenError; si falla la redacción la vuelve a abrir y relanza.
   */
  async function answerEscalation(escalationId: number, answer: string): Promise<void> {
    const esc = await claimEscalation(db, escalationId);
    if (!esc) {
      if (!(await getEscalation(db, escalationId))) return;
      throw new EscalationNotOpenError(escalationId);
    }
    const p = await getProspect(db, esc.prospectId);
    let text = '';
    try {
      if (p) {
        const k = await loadKnowledge(db);
        text = await llm.text({
          agent: 'vendedor',
          system: buildTextPrompt(k, p, config.ownerName),
          messages: [
            ...(await history(p.id)),
            { role: 'user', content: `[Instrucción interna] ${config.ownerName} respondió tu consulta "${esc.question}": "${answer}". Redactá la respuesta para el prospecto, en el estilo de ${config.ownerName}. Solo el mensaje.` },
          ],
        });
      }
    } catch (e) {
      await releaseEscalation(db, escalationId);
      throw e;
    }
    await answerEscalationRow(db, escalationId, answer);
    await addFaq(db, esc.question, answer);
    if (!p) return;
    await say(p.id, text);
    await updateProspect(db, p.id, { needsAttention: null });
  }

  async function runFollowups(now: Date): Promise<number> {
    let sent = 0;
    for (const p of await listProspectsForHub(db)) {
      if (p.status !== 'contactado' || p.handedOff || p.lastInboundAt || !p.lastOutboundAt) continue;
      const elapsed = now.getTime() - p.lastOutboundAt.getTime();
      if (p.followupsSent < config.maxFollowups) {
        if (elapsed < config.followupDays * DAY_MS) continue;
        let text: string;
        try {
          const k = await loadKnowledge(db);
          text = await llm.text({
            agent: 'vendedor',
            system: buildTextPrompt(k, p, config.ownerName),
            messages: [
              ...(await history(p.id)),
              { role: 'user', content: '[Instrucción interna] No respondió. Escribí un seguimiento muy breve, amable y sin presionar. Solo el mensaje.' },
            ],
          });
        } catch (e) {
          await logEvent(db, 'followup_error', { prospectId: p.id, error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        if (!text.trim()) continue;
        await say(p.id, text);
        await updateProspect(db, p.id, { followupsSent: p.followupsSent + 1 });
        sent++;
      } else if (elapsed >= config.closeAfterDays * DAY_MS) {
        await setStatus(db, p.id, 'sin_respuesta');
      }
    }
    return sent;
  }

  return { pickOpenerVariant, startConversation, handleInbound, answerEscalation, runFollowups };
}
