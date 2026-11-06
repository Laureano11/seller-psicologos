import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import {
  BLOCKED_STATUSES, addMessage, createEscalation, dueOutbox, enqueueOutbox, getProspect, getProspectByWaId,
  isOptedOut, isSystemWaMessageId, kvGet, logEvent, markOutboxFailed, markOutboxSent, recordOutboxAttemptFailed,
  updateProspect,
} from '../db/repo.js';
import { isInWindow } from '../time.js';
import type { IncomingMsg, MediaKind, WaTransport } from './transport.js';

/** Intentos de envío antes de dar un item del outbox por fallido. */
export const MAX_SEND_ATTEMPTS = 5;

/** Cómo se le avisa al dueño de un mensaje que el agente no puede leer. */
const MEDIA_ASK: Record<MediaKind, string> = {
  audio: 'un audio, escuchalo',
  imagen: 'una imagen, mirala',
  sticker: 'un sticker, miralo',
  documento: 'un documento, miralo',
  video: 'un video, miralo',
  no_soportado: 'un mensaje que no puedo leer, miralo',
};

type SentRecord = { waMessageId: string; prospectId: number | null; body: string; marked: boolean; logged: boolean };

export class WaGateway {
  /** Ids devueltos por el transporte en esta sesión (cubre el eco fromMe previo a markOutboxSent). */
  private readonly sentIds = new Set<string>();
  /** Envíos en curso por destinatario: el eco fromMe puede llegar antes de que conozcamos el id. */
  private readonly inflight = new Map<string, Set<Promise<unknown>>>();

  /** Items del outbox ya enviados en este proceso cuyo registro está incompleto (evita reenviar). */
  private readonly sentOutbox = new Map<number, SentRecord>();

  constructor(private db: Db, private transport: WaTransport, private config: Config) {}

  async handleIncoming(m: IncomingMsg): Promise<{ prospectId: number; triggerAgent: boolean } | null> {
    if (m.fromWaId === this.config.ownerWaId) return null;
    const p = await getProspectByWaId(this.db, m.fromWaId);
    if (!p) return null;

    if (m.fromMe) {
      const pending = this.inflight.get(m.fromWaId);
      if (pending) await Promise.allSettled([...pending]);
      if (this.sentIds.has(m.id) || (await isSystemWaMessageId(this.db, m.id))) return null;
      const inserted = await addMessage(this.db, { prospectId: p.id, direction: 'out', author: 'lauri', body: m.text, waMessageId: m.id });
      if (!inserted) return null; // reentrega
      await updateProspect(this.db, p.id, { handedOff: true });
      return { prospectId: p.id, triggerAgent: false };
    }

    const inserted = await addMessage(this.db, { prospectId: p.id, direction: 'in', author: 'prospect', body: m.text, waMessageId: m.id });
    if (!inserted) return null; // reentrega de Baileys
    if (p.status === 'encontrado' && !p.handedOff) {
      // el sistema nunca le escribió: es una relación previa de Lauri, no se toca
      await updateProspect(this.db, p.id, { lastInboundAt: m.at, handedOff: true });
      return { prospectId: p.id, triggerAgent: false };
    }
    const active = !p.handedOff && !BLOCKED_STATUSES.includes(p.status);
    if (m.media && active) {
      // el agente no puede escuchar/ver: se escala al dueño sin llamar al modelo
      const question = `Te mandó ${MEDIA_ASK[m.media]} en el celular`;
      await updateProspect(this.db, p.id, { lastInboundAt: m.at, inboundHandledAt: m.at, needsAttention: 'pregunta' });
      await createEscalation(this.db, p.id, question);
      await this.enqueueToOwner(`❓ ${p.name} te mandó ${MEDIA_ASK[m.media]} en el celular y respondé en el hub`);
      return { prospectId: p.id, triggerAgent: false };
    }
    await updateProspect(this.db, p.id, { lastInboundAt: m.at });
    return { prospectId: p.id, triggerAgent: active };
  }

  async enqueueToProspect(prospectId: number, body: string, opts?: { sendAfter?: Date }): Promise<number> {
    const p = await getProspect(this.db, prospectId);
    if (!p?.waId) throw new Error(`Prospecto ${prospectId} sin WhatsApp`);
    return enqueueOutbox(this.db, {
      prospectId, toWaId: p.waId, body, kind: 'prospect', sendAfter: opts?.sendAfter ?? new Date(),
    });
  }

  enqueueToOwner(body: string): Promise<number> {
    return enqueueOutbox(this.db, {
      prospectId: null, toWaId: this.config.ownerWaId, body, kind: 'self', sendAfter: new Date(),
    });
  }

  async flushOutbox(now: Date): Promise<number> {
    // sin conexión no se intenta nada: los items quedan pendientes hasta que vuelva
    if ((await kvGet<{ state: string }>(this.db, 'wa_status'))?.state !== 'conectado') return 0;
    let sent = 0;
    for (const item of await dueOutbox(this.db, now)) {
      const done = this.sentOutbox.get(item.id);
      if (done) {
        await this.settle(item.id, done, now); // ya se envió: solo reintentar el registro
        continue;
      }
      let prospectId: number | null = null;
      if (item.kind === 'self') {
        if (item.toWaId !== this.config.ownerWaId) {
          await markOutboxFailed(this.db, item.id, 'bloqueado');
          continue;
        }
      } else {
        const p = item.prospectId == null ? undefined : await getProspect(this.db, item.prospectId);
        if (!p || !p.waId || p.waId !== item.toWaId || p.handedOff || BLOCKED_STATUSES.includes(p.status)
          || (await isOptedOut(this.db, item.toWaId))) {
          await markOutboxFailed(this.db, item.id, 'bloqueado');
          continue;
        }
        if (!isInWindow(now, this.config.sendWindow, this.config.tz)) continue;
        prospectId = p.id;
      }

      const op = Promise.resolve()
        .then(() => this.transport.send(item.toWaId, item.body))
        .then((id) => {
          this.sentIds.add(id);
          return id;
        });
      this.track(item.toWaId, op);
      let waMessageId: string;
      try {
        waMessageId = await op;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const row = await recordOutboxAttemptFailed(this.db, item.id, error, MAX_SEND_ATTEMPTS);
        if (row.status === 'fallido') {
          await logEvent(this.db, 'outbox_fallido', { outboxId: item.id, prospectId: item.prospectId, kind: item.kind, intentos: row.attempts, error });
        }
        continue;
      }
      sent++;
      // El envío ya ocurrió: si falla el registro, nunca marcar fallido ni reenviar.
      const rec: SentRecord = { waMessageId, prospectId, body: item.body, marked: false, logged: false };
      this.sentOutbox.set(item.id, rec);
      await this.settle(item.id, rec, now);
    }
    return sent;
  }

  /** Completa el registro de un envío ya hecho; si falla algo, queda en `sentOutbox` para reintentar. */
  private async settle(outboxId: number, rec: SentRecord, now: Date): Promise<void> {
    try {
      if (!rec.marked) {
        await markOutboxSent(this.db, outboxId, rec.waMessageId);
        rec.marked = true;
      }
      if (!rec.logged) {
        if (rec.prospectId != null) {
          await addMessage(this.db, {
            prospectId: rec.prospectId, direction: 'out', author: 'agent', body: rec.body, waMessageId: rec.waMessageId,
          });
          await updateProspect(this.db, rec.prospectId, { lastOutboundAt: now });
        }
        rec.logged = true;
      }
      this.sentOutbox.delete(outboxId);
    } catch (e) {
      console.error(`Outbox ${outboxId}: enviado (${rec.waMessageId}) pero falló el registro`, e);
    }
  }

  private track(waId: string, p: Promise<unknown>): void {
    const set = this.inflight.get(waId) ?? new Set();
    this.inflight.set(waId, set);
    set.add(p);
    const done = () => { set.delete(p); if (set.size === 0) this.inflight.delete(waId); };
    p.then(done, done);
  }
}
