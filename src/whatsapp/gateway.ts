import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import {
  BLOCKED_STATUSES, addMessage, dueOutbox, enqueueOutbox, getProspect, getProspectByWaId,
  isOptedOut, isSystemWaMessageId, messageExistsByWaId, markOutboxFailed, markOutboxSent, updateProspect,
} from '../db/repo.js';
import { isInWindow } from '../time.js';
import type { IncomingMsg, WaTransport } from './transport.js';

export class WaGateway {
  /** Ids devueltos por el transporte en esta sesión (cubre el eco fromMe previo a markOutboxSent). */
  private readonly sentIds = new Set<string>();
  /** Envíos en curso por destinatario: el eco fromMe puede llegar antes de que conozcamos el id. */
  private readonly inflight = new Map<string, Set<Promise<unknown>>>();

  constructor(private db: Db, private transport: WaTransport, private config: Config) {}

  async handleIncoming(m: IncomingMsg): Promise<{ prospectId: number; triggerAgent: boolean } | null> {
    if (m.fromWaId === this.config.ownerWaId) return null;
    const p = await getProspectByWaId(this.db, m.fromWaId);
    if (!p) return null;
    if (await messageExistsByWaId(this.db, m.id)) return null; // reentrega de Baileys

    if (m.fromMe) {
      const pending = this.inflight.get(m.fromWaId);
      if (pending) await Promise.allSettled([...pending]);
      if (this.sentIds.has(m.id) || (await isSystemWaMessageId(this.db, m.id))) return null;
      await addMessage(this.db, { prospectId: p.id, direction: 'out', author: 'lauri', body: m.text, waMessageId: m.id });
      await updateProspect(this.db, p.id, { handedOff: true });
      return { prospectId: p.id, triggerAgent: false };
    }

    await addMessage(this.db, { prospectId: p.id, direction: 'in', author: 'prospect', body: m.text, waMessageId: m.id });
    await updateProspect(this.db, p.id, { lastInboundAt: m.at });
    return { prospectId: p.id, triggerAgent: !p.handedOff && !BLOCKED_STATUSES.includes(p.status) };
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
    let sent = 0;
    for (const item of await dueOutbox(this.db, now)) {
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

      const op = this.transport.send(item.toWaId, item.body).then((id) => {
        this.sentIds.add(id);
        return id;
      });
      this.track(item.toWaId, op);
      let waMessageId: string;
      try {
        waMessageId = await op;
      } catch (e) {
        await markOutboxFailed(this.db, item.id, e instanceof Error ? e.message : String(e));
        continue;
      }
      sent++;
      // El envío ya ocurrió: si falla el registro, nunca marcar el item como fallido.
      try {
        await markOutboxSent(this.db, item.id, waMessageId);
        if (prospectId != null) {
          await addMessage(this.db, { prospectId, direction: 'out', author: 'agent', body: item.body, waMessageId });
          await updateProspect(this.db, prospectId, { lastOutboundAt: now });
        }
      } catch (e) {
        console.error(`Outbox ${item.id}: enviado (${waMessageId}) pero falló el registro`, e);
      }
    }
    return sent;
  }

  private track(waId: string, p: Promise<unknown>): void {
    const set = this.inflight.get(waId) ?? new Set();
    this.inflight.set(waId, set);
    set.add(p);
    const done = () => { set.delete(p); if (set.size === 0) this.inflight.delete(waId); };
    p.then(done, done);
  }
}
