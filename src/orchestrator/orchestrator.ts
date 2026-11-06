import { DateTime } from 'luxon';
import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import type { WaGateway } from '../whatsapp/gateway.js';
import type { IncomingMsg, WaStatus } from '../whatsapp/transport.js';
import type { createVendedor } from '../agents/vendedor/vendedor.js';
import { countContactedSince, countOptOutsSince, kvGet, kvSet, logEvent, pickContactable } from '../db/repo.js';
import { isInWindow } from '../time.js';

export interface OrchestratorDeps {
  db: Db;
  config: Config;
  gateway: Pick<WaGateway, 'handleIncoming' | 'enqueueToOwner' | 'flushOutbox'>;
  vendedor: Pick<ReturnType<typeof createVendedor>, 'handleInbound' | 'startConversation' | 'runFollowups'>;
  runBuscador: (now: Date) => Promise<unknown>;
  runWeeklyAnalysis: (now: Date) => Promise<unknown>;
}

const MIN = 60_000;
const NEW_CONTACT_SPACING_MS = 30 * MIN;
const WA_DOWN_ALERT_MS = 10 * MIN;
const MAX_RETRIES_PER_TICK = 5;
const BRAKE_BAJAS = 3;
const FAIL_STREAK_ALERT = 3;

export function createOrchestrator(deps: OrchestratorDeps) {
  const { db, config, gateway, vendedor } = deps;

  const dueAt = new Map<number, Date>(); // prospectId -> hora programada del handleInbound
  const failStreak = new Map<string, number>();
  const alerted = new Set<string>();
  let running = false;
  let waDownSince: Date | null = null;
  let waDownLogged = false;

  const local = (now: Date) => DateTime.fromJSDate(now, { zone: config.tz });

  async function onIncoming(m: IncomingMsg, now: Date): Promise<void> {
    const r = await gateway.handleIncoming(m);
    if (r?.triggerAgent) dueAt.set(r.prospectId, new Date(now.getTime() + config.replyDebounceSeconds * 1000));
  }

  async function runDue(now: Date): Promise<void> {
    const due = [...dueAt.entries()].filter(([, at]) => at.getTime() <= now.getTime());
    for (const [prospectId] of due) {
      dueAt.delete(prospectId);
      try {
        await vendedor.handleInbound(prospectId, now);
      } catch (e) {
        await logEvent(db, 'error', { paso: 'responder', prospectId, mensaje: errMsg(e) });
      }
    }
  }

  async function step(paso: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      failStreak.delete(paso);
      alerted.delete(paso);
    } catch (e) {
      const mensaje = errMsg(e);
      const n = (failStreak.get(paso) ?? 0) + 1;
      failStreak.set(paso, n);
      try {
        await logEvent(db, 'error', { paso, mensaje });
        if (n >= FAIL_STREAK_ALERT && !alerted.has(paso)) {
          alerted.add(paso);
          await gateway.enqueueToOwner(`⚠️ El paso ${paso} falló 3 veces seguidas: ${mensaje}`);
        }
      } catch { /* no hay más que hacer */ }
    }
  }

  async function tick(now: Date): Promise<void> {
    if (running) return;
    running = true;
    try {
      const dt = local(now);
      const today = dt.toISODate()!;

      await step('responder', () => runDue(now));

      await step('buscador', async () => {
        if (dt.hour < config.searchHour || (await kvGet<string>(db, 'buscador_last_date')) === today) return;
        await deps.runBuscador(now);
        await kvSet(db, 'buscador_last_date', today);
      });

      // El freno se evalúa antes de iniciar contactos para que el mismo tick ya respete la pausa.
      await step('freno', async () => {
        if (await kvGet(db, 'pausa_nuevos')) return;
        const n = await countOptOutsSince(db, new Date(now.getTime() - 7 * 24 * 60 * MIN));
        if (n < BRAKE_BAJAS) return;
        await kvSet(db, 'pausa_nuevos', { since: now.toISOString(), motivo: `${n} bajas en los últimos 7 días` });
        await gateway.enqueueToOwner(`⛔ Pausé los contactos nuevos: hubo ${n} bajas en los últimos 7 días. Revisalo en el hub.`);
      });

      await step('nuevos_contactos', async () => {
        if (!isInWindow(now, config.sendWindow, config.tz)) return;
        if (await kvGet(db, 'pausa_nuevos')) return;
        if ((await countContactedSince(db, dt.startOf('day').toJSDate())) >= config.dailyNewContacts) return;
        const last = await kvGet<string>(db, 'last_new_contact_at');
        if (last && now.getTime() - new Date(last).getTime() < NEW_CONTACT_SPACING_MS) return;
        const [p] = await pickContactable(db, 1);
        if (!p) return;
        await vendedor.startConversation(p.id, now);
        await kvSet(db, 'last_new_contact_at', now.toISOString());
      });

      await step('seguimientos', async () => {
        if (dt.hour < 10 || (await kvGet<string>(db, 'followups_last_date')) === today) return;
        await vendedor.runFollowups(now);
        await kvSet(db, 'followups_last_date', today);
      });

      await step('reintentos', async () => {
        const pending = (await kvGet<number[]>(db, 'pending_inbound')) ?? [];
        const batch = pending.slice(0, MAX_RETRIES_PER_TICK);
        if (!batch.length) return;
        // R2: se sacan antes de reintentar; handleInbound los vuelve a agregar si falla de nuevo.
        await kvSet(db, 'pending_inbound', pending.filter((id) => !batch.includes(id)));
        for (const id of batch) await vendedor.handleInbound(id, now);
      });

      await step('analisis', async () => {
        const week = dt.toFormat("kkkk-'W'WW");
        if (dt.weekday !== 1 || dt.hour < 8 || (await kvGet<string>(db, 'analysis_last_week')) === week) return;
        await deps.runWeeklyAnalysis(now);
        await kvSet(db, 'analysis_last_week', week);
      });

      await step('wa_estado', async () => {
        if (waDownSince && !waDownLogged && now.getTime() - waDownSince.getTime() > WA_DOWN_ALERT_MS) {
          waDownLogged = true;
          await logEvent(db, 'wa_desconectado', { desde: waDownSince.toISOString() });
        }
      });

      await step('outbox', async () => { await gateway.flushOutbox(now); });
    } finally {
      running = false;
    }
  }

  async function onWaStatus(s: WaStatus, now: Date = new Date()): Promise<void> {
    await kvSet(db, 'wa_status', s);
    if (s.state === 'conectado') {
      waDownSince = null;
      waDownLogged = false;
    } else if (s.state === 'desconectado') {
      waDownSince ??= now;
    } else if (s.state === 'sesion_cerrada') {
      await logEvent(db, 'wa_sesion_cerrada', {});
    }
  }

  return { onIncoming, runDue, tick, onWaStatus };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
