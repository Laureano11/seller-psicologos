import { DateTime } from 'luxon';
import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import type { WaGateway } from '../whatsapp/gateway.js';
import type { IncomingMsg, WaStatus } from '../whatsapp/transport.js';
import type { createVendedor } from '../agents/vendedor/vendedor.js';
import {
  countContactedSince, countOptOutsSince, getProspect, kvGet, kvSet, listUnansweredInbound, logEvent, pickContactable,
  updateProspect,
} from '../db/repo.js';
import { isInWindow, nextSendTime } from '../time.js';

export interface OrchestratorDeps {
  db: Db;
  config: Config;
  gateway: Pick<WaGateway, 'handleIncoming' | 'enqueueToOwner' | 'flushOutbox'>;
  vendedor: Pick<ReturnType<typeof createVendedor>, 'handleInbound' | 'startConversation' | 'runFollowups'>;
  /** Pasa los psicólogos de data/prospectos.json a la base. Corre en segundo plano; `signal` se aborta con stop(). */
  runImportador: (now: Date, signal: AbortSignal) => Promise<unknown>;
  runWeeklyAnalysis: (now: Date) => Promise<unknown>;
}

const MIN = 60_000;
const NEW_CONTACT_SPACING_MS = 30 * MIN;
const WA_DOWN_ALERT_MS = 10 * MIN;
const MAX_RETRIES_PER_TICK = 5;
const BRAKE_BAJAS = 3;
const FAIL_STREAK_ALERT = 3;
const RETRY_FAILED_MS = 30 * MIN;
const IMPORT_EVERY_MS = 10 * MIN;

export function createOrchestrator(deps: OrchestratorDeps) {
  const { db, config, gateway, vendedor } = deps;

  const dueAt = new Map<number, Date>(); // prospectId -> hora programada del handleInbound
  const failStreak = new Map<string, number>();
  const alerted = new Set<string>();
  const lastFailure = new Map<string, Date>();
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();
  let waDownSince: Date | null = null;
  let waDownLogged = false;
  let importRun: Promise<void> | null = null;
  let importAbort: AbortController | null = null;
  let lastImportAt: Date | null = null;
  let lastTickAt: Date | null = null; // hora del último tick: aproxima cuándo falló una tarea en segundo plano

  const local = (now: Date) => DateTime.fromJSDate(now, { zone: config.tz });

  async function onIncoming(m: IncomingMsg, now: Date): Promise<void> {
    const r = await gateway.handleIncoming(m);
    if (r?.triggerAgent) dueAt.set(r.prospectId, new Date(now.getTime() + config.replyDebounceSeconds * 1000));
  }

  async function addPending(prospectId: number): Promise<void> {
    const pending = (await kvGet<number[]>(db, 'pending_inbound')) ?? [];
    if (!pending.includes(prospectId)) await kvSet(db, 'pending_inbound', [...pending, prospectId]);
  }

  async function safeAddPending(prospectId: number): Promise<void> {
    try {
      await addPending(prospectId);
    } catch (e) {
      await logEvent(db, 'error', { paso: 'pending_inbound', prospectId, mensaje: errMsg(e) }).catch(() => {});
    }
  }

  /** Llama al vendedor y marca el último entrante como atendido (para que la recuperación no lo repita). */
  async function respond(prospectId: number, now: Date): Promise<void> {
    const before = await getProspect(db, prospectId);
    await vendedor.handleInbound(prospectId, now);
    if (before?.lastInboundAt) await updateProspect(db, prospectId, { inboundHandledAt: before.lastInboundAt });
  }

  async function runDue(now: Date): Promise<void> {
    const due = [...dueAt.entries()].filter(([, at]) => at.getTime() <= now.getTime());
    if (due.length && !isInWindow(now, config.sendWindow, config.tz)) {
      // fuera de horario no se responde: se reprograma al inicio de la próxima ventana (una sola respuesta)
      const next = nextSendTime(now, config.sendWindow, config.tz);
      for (const [prospectId] of due) dueAt.set(prospectId, next);
      return;
    }
    const errors: string[] = [];
    for (const [prospectId] of due) {
      dueAt.delete(prospectId);
      try {
        await respond(prospectId, now);
      } catch (e) {
        errors.push(errMsg(e));
        await safeAddPending(prospectId); // no se pierde la respuesta: la reintenta el paso de reintentos
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  }

  /** El debounce vive en memoria: tras un reinicio, recupera entrantes sin responder desde la base. */
  async function recoverUnanswered(now: Date): Promise<void> {
    const ids = await listUnansweredInbound(db, new Date(now.getTime() - config.replyDebounceSeconds * 1000));
    if (!ids.length) return;
    const pending = (await kvGet<number[]>(db, 'pending_inbound')) ?? [];
    for (const id of ids) if (!dueAt.has(id) && !pending.includes(id)) dueAt.set(id, now);
  }

  function recordSuccess(paso: string): void {
    failStreak.delete(paso);
    lastFailure.delete(paso);
    alerted.delete(paso);
  }

  async function recordFailure(paso: string, e: unknown, now?: Date): Promise<void> {
    const mensaje = errMsg(e);
    if (now) lastFailure.set(paso, now);
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

  /** `deferred`: el éxito/fracaso real se registra después (tarea en segundo plano), no al volver de fn. */
  async function step(
    paso: string,
    fn: () => Promise<void>,
    opts: { now?: Date; backoff?: boolean; deferred?: boolean } = {},
  ): Promise<void> {
    if (opts.backoff && opts.now) {
      const failedAt = lastFailure.get(paso);
      if (failedAt && opts.now.getTime() - failedAt.getTime() < RETRY_FAILED_MS) return;
    }
    try {
      await fn();
      if (!opts.deferred) recordSuccess(paso);
    } catch (e) {
      await recordFailure(paso, e, opts.now);
    }
  }

  /** Lanza la importación sin esperarla (las pausas antes de cada consulta a WhatsApp la hacen lenta). */
  function startImportador(now: Date): void {
    const ac = new AbortController();
    importAbort = ac;
    lastImportAt = now;
    importRun = (async () => {
      try {
        await deps.runImportador(now, ac.signal);
        recordSuccess('importar');
      } catch (e) {
        // el backoff cuenta desde la falla (último tick), no desde el inicio
        await recordFailure('importar', e, lastTickAt ?? now);
      } finally {
        importRun = null;
        importAbort = null;
      }
    })();
  }

  /** Aborta la importación en curso (apagado). */
  function stop(): void {
    importAbort?.abort();
  }

  /** Resuelve cuando termina la importación en curso (si hay). */
  async function idleImportador(): Promise<void> {
    await importRun;
  }

  function tick(now: Date): Promise<void> {
    if (running) return Promise.resolve();
    running = true;
    inFlight = doTick(now).finally(() => { running = false; });
    return inFlight;
  }

  /** Resuelve cuando termina el tick en curso (si hay). */
  async function idle(): Promise<void> {
    await inFlight.catch(() => {});
  }

  async function doTick(now: Date): Promise<void> {
    lastTickAt = now;
    {
      const dt = local(now);
      const today = dt.toISODate()!;

      await step('recuperar', () => recoverUnanswered(now));
      await step('responder', () => runDue(now));

      await step('importar', async () => {
        if (importRun) return;
        if (lastImportAt && now.getTime() - lastImportAt.getTime() < IMPORT_EVERY_MS) return;
        startImportador(now);
      }, { now, backoff: true, deferred: true });

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
        // si no encoló nada (no-op), no consume el espaciado de 30 min
        if (await vendedor.startConversation(p.id, now)) await kvSet(db, 'last_new_contact_at', now.toISOString());
      });

      await step('seguimientos', async () => {
        if (!isInWindow(now, config.sendWindow, config.tz)) return;
        if (dt.hour < 10 || (await kvGet<string>(db, 'followups_last_date')) === today) return;
        await vendedor.runFollowups(now);
        await kvSet(db, 'followups_last_date', today);
      }, { now, backoff: true });

      await step('reintentos', async () => {
        if (!isInWindow(now, config.sendWindow, config.tz)) return; // igual que runDue: fuera de horario no se responde
        const pending = (await kvGet<number[]>(db, 'pending_inbound')) ?? [];
        const batch = pending.slice(0, MAX_RETRIES_PER_TICK);
        if (!batch.length) return;
        // R2: se sacan antes de reintentar; handleInbound los vuelve a agregar si falla de nuevo.
        await kvSet(db, 'pending_inbound', pending.filter((id) => !batch.includes(id)));
        const errors: string[] = [];
        for (const id of batch) {
          try {
            await respond(id, now);
          } catch (e) {
            errors.push(errMsg(e));
            await safeAddPending(id);
          }
        }
        if (errors.length) throw new Error(errors.join('; '));
      });

      await step('analisis', async () => {
        const week = dt.toFormat("kkkk-'W'WW");
        if (dt.weekday !== 1 || dt.hour < 8 || (await kvGet<string>(db, 'analysis_last_week')) === week) return;
        await deps.runWeeklyAnalysis(now);
        await kvSet(db, 'analysis_last_week', week);
      }, { now, backoff: true });

      await step('wa_estado', async () => {
        if (waDownSince && !waDownLogged && now.getTime() - waDownSince.getTime() > WA_DOWN_ALERT_MS) {
          waDownLogged = true;
          await logEvent(db, 'wa_desconectado', { desde: waDownSince.toISOString() });
        }
      });

      await step('outbox', async () => { await gateway.flushOutbox(now); });
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

  return { onIncoming, runDue, tick, idle, onWaStatus, stop, idleImportador };
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
