import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';

export type Status =
  | 'encontrado' | 'contactado' | 'conversando' | 'interesado' | 'reunion_agendada'
  | 'listo_para_cerrar' | 'rechazado' | 'sin_respuesta' | 'baja' | 'descartado';

export const BLOCKED_STATUSES: Status[] = ['baja', 'rechazado', 'listo_para_cerrar', 'descartado'];

export interface Prospect {
  id: number;
  name: string;
  phoneRaw: string | null;
  waId: string | null;
  email: string | null;
  city: string | null;
  province: string | null;
  address: string | null;
  website: string | null;
  source: string | null;
  sourceRef: string | null;
  profileUrls: string[];
  practiceType: string;
  toolsSignals: string | null;
  fitNotes: string | null;
  attributes: Record<string, unknown>;
  status: Status;
  statusReason: string | null;
  needsAttention: string | null;
  handedOff: boolean;
  openerVariantId: number | null;
  followupsSent: number;
  evaluation: Record<string, unknown>;
  tags: { objections: string[]; [k: string]: unknown };
  contactedAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  /** last_inbound_at del último entrante ya atendido (por el vendedor o escalado al dueño). */
  inboundHandledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewProspect = Partial<Omit<Prospect, 'id' | 'name' | 'createdAt' | 'updatedAt'>> & { name: string };

export interface Message {
  id: number;
  prospectId: number;
  direction: 'in' | 'out';
  author: 'prospect' | 'agent' | 'lauri';
  body: string;
  waMessageId: string | null;
  createdAt: Date;
}

export interface OutboxItem {
  id: number;
  prospectId: number | null;
  toWaId: string;
  body: string;
  kind: 'prospect' | 'self';
  sendAfter: Date;
  status: string;
  waMessageId: string | null;
  error: string | null;
  attempts: number;
  lastError: string | null;
}

export interface Escalation {
  id: number;
  prospectId: number;
  question: string;
  answer: string | null;
  status: string;
  createdAt: Date;
  answeredAt: Date | null;
}

export interface Faq { id: number; question: string; answer: string; createdAt: Date }
export type ManualKind = 'ventas' | 'producto' | 'estilo';
export interface ManualVersion { id: number; kind: ManualKind; content: string; source: string; active: boolean; createdAt: Date }
export type VariantStatus = 'activa' | 'candidata' | 'retirada';
export interface Variant { id: number; template: string; status: VariantStatus; proposalId: number | null; createdAt: Date }
export type ProposalKind = 'apertura_nueva' | 'promover_apertura' | 'manual';
export interface Proposal {
  id: number; kind: ProposalKind; summary: string; evidence: string; proposedContent: string;
  targetId: number | null; status: string; createdAt: Date; decidedAt: Date | null;
}
export interface Meeting {
  id: number; prospectId: number; startsAt: Date; endsAt: Date;
  calendarEventId: string | null; meetUrl: string | null; status: string; createdAt: Date;
}
export interface NewMeeting {
  prospectId: number; startsAt: Date; endsAt: Date; calendarEventId?: string; meetUrl?: string;
}
export interface EventRow { id: number; type: string; payload: any; createdAt: Date }

// ---------- helpers ----------

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

function mapRow<T>(row: Record<string, unknown> | undefined): T | undefined {
  if (!row) return undefined;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v])) as T;
}
const mapRows = <T>(rows: Record<string, unknown>[]): T[] => rows.map((r) => mapRow<T>(r)!);

/** Objetos/arrays van como JSON (pg convertiría arrays a arrays de Postgres); Date y primitivos quedan igual. */
const toParam = (v: unknown) =>
  v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v ?? null;

function columns(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const col = snake(k);
      if (!/^[a-z_]+$/.test(col)) throw new Error(`Columna inválida: ${k}`);
      return [col, toParam(v)];
    });
}

// ---------- prospects ----------

export async function insertProspect(db: Db, p: NewProspect): Promise<Prospect | null> {
  const cols = columns(p);
  const rows = await db.query(
    `INSERT INTO prospects (${cols.map(([c]) => c).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (wa_id) DO NOTHING RETURNING *`,
    cols.map(([, v]) => v),
  );
  return mapRow<Prospect>(rows[0]) ?? null;
}

export async function getProspect(db: Db, id: number): Promise<Prospect | undefined> {
  return mapRow<Prospect>((await db.query('SELECT * FROM prospects WHERE id=$1', [id]))[0]);
}

export async function getProspectByWaId(db: Db, waId: string): Promise<Prospect | undefined> {
  return mapRow<Prospect>((await db.query('SELECT * FROM prospects WHERE wa_id=$1', [waId]))[0]);
}

export async function updateProspect(db: Db, id: number, patch: Partial<Prospect>): Promise<Prospect | undefined> {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = patch;
  const cols = columns(rest);
  const sets = [...cols.map(([c], i) => `${c}=$${i + 2}`), 'updated_at=now()'];
  const rows = await db.query(`UPDATE prospects SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, [id, ...cols.map(([, v]) => v)]);
  return mapRow<Prospect>(rows[0]);
}

export async function setStatus(db: Db, id: number, status: Status, reason?: string): Promise<void> {
  await db.query('UPDATE prospects SET status=$2, status_reason=$3, updated_at=now() WHERE id=$1', [id, status, reason ?? null]);
}

export async function listProspectsForHub(db: Db): Promise<Prospect[]> {
  return mapRows(await db.query(
    `SELECT * FROM prospects
     ORDER BY (needs_attention IS NULL), (status <> 'listo_para_cerrar'), updated_at DESC, id DESC`,
  ));
}

export async function pickContactable(db: Db, limit: number): Promise<Prospect[]> {
  return mapRows(await db.query(
    `SELECT * FROM prospects
     WHERE status='encontrado' AND wa_id IS NOT NULL AND NOT handed_off
       AND wa_id NOT IN (SELECT wa_id FROM opt_outs)
     ORDER BY created_at ASC, id ASC LIMIT $1`,
    [limit],
  ));
}

/**
 * Prospectos con un entrante sin atender (último entrante posterior al último saliente y a la última atención),
 * más viejo que `before`, sin toma de control, en estado activo y sin respuesta pendiente en el outbox.
 */
export async function listUnansweredInbound(db: Db, before: Date): Promise<number[]> {
  const r = await db.query<{ id: number }>(
    `SELECT p.id FROM prospects p
     WHERE p.last_inbound_at IS NOT NULL AND p.last_inbound_at <= $1
       AND p.last_inbound_at > coalesce(p.last_outbound_at, p.contacted_at, 'epoch')
       AND p.last_inbound_at > coalesce(p.inbound_handled_at, 'epoch')
       AND NOT p.handed_off AND p.status <> ALL($2)
       AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.prospect_id=p.id AND o.status='pendiente')
     ORDER BY p.last_inbound_at, p.id`,
    [before, BLOCKED_STATUSES],
  );
  return r.map((x) => x.id);
}

export async function countContactedSince(db: Db, since: Date): Promise<number> {
  const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM prospects WHERE contacted_at >= $1', [since]);
  return r[0].n;
}

// ---------- messages ----------

/** Devuelve true si se insertó; false si ya existía un mensaje con ese wa_message_id. */
export async function addMessage(
  db: Db,
  m: { prospectId: number; direction: 'in' | 'out'; author: 'prospect' | 'agent' | 'lauri'; body: string; waMessageId?: string },
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO messages (prospect_id, direction, author, body, wa_message_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING RETURNING id`,
    [m.prospectId, m.direction, m.author, m.body, m.waMessageId ?? null],
  );
  return r.length > 0;
}

export async function listMessages(db: Db, prospectId: number): Promise<Message[]> {
  return mapRows(await db.query('SELECT * FROM messages WHERE prospect_id=$1 ORDER BY id', [prospectId]));
}

// ---------- outbox ----------

export async function enqueueOutbox(
  db: Db,
  o: { prospectId: number | null; toWaId: string; body: string; kind: 'prospect' | 'self'; sendAfter: Date },
): Promise<number> {
  const r = await db.query<{ id: number }>(
    'INSERT INTO outbox (prospect_id, to_wa_id, body, kind, send_after) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [o.prospectId, o.toWaId, o.body, o.kind, o.sendAfter],
  );
  return r[0].id;
}

export async function dueOutbox(db: Db, now: Date): Promise<OutboxItem[]> {
  return mapRows(await db.query(
    "SELECT * FROM outbox WHERE status='pendiente' AND send_after <= $1 ORDER BY send_after, id",
    [now],
  ));
}

export async function markOutboxSent(db: Db, id: number, waMessageId: string): Promise<void> {
  await db.query("UPDATE outbox SET status='enviado', wa_message_id=$2, sent_at=now() WHERE id=$1", [id, waMessageId]);
}

export async function markOutboxFailed(db: Db, id: number, error: string): Promise<void> {
  await db.query("UPDATE outbox SET status='fallido', error=$2 WHERE id=$1", [id, error]);
}

/** Registra un intento de envío fallido; al llegar a `maxAttempts` lo marca fallido. Devuelve el item actualizado. */
export async function recordOutboxAttemptFailed(db: Db, id: number, error: string, maxAttempts: number): Promise<OutboxItem> {
  const rows = await db.query(
    `UPDATE outbox SET attempts=attempts+1, last_error=$2,
       status=CASE WHEN attempts+1 >= $3 THEN 'fallido' ELSE status END,
       error=CASE WHEN attempts+1 >= $3 THEN $2 ELSE error END
     WHERE id=$1 RETURNING *`,
    [id, error, maxAttempts],
  );
  return mapRow<OutboxItem>(rows[0])!;
}

// ---------- escalations / faq ----------

export async function createEscalation(db: Db, prospectId: number, question: string): Promise<number> {
  const r = await db.query<{ id: number }>('INSERT INTO escalations (prospect_id, question) VALUES ($1,$2) RETURNING id', [prospectId, question]);
  return r[0].id;
}

/** La escalación ya no está abierta (otra respuesta la tomó o ya fue respondida). */
export class EscalationNotOpenError extends Error {
  constructor(id: number) {
    super(`La consulta ${id} ya fue respondida`);
    this.name = 'EscalationNotOpenError';
  }
}

/** Toma la escalación de forma atómica (abierta -> respondiendo); undefined si ya no estaba abierta. */
export async function claimEscalation(db: Db, id: number): Promise<Escalation | undefined> {
  return mapRow<Escalation>((await db.query(
    "UPDATE escalations SET status='respondiendo' WHERE id=$1 AND status='abierta' RETURNING *", [id],
  ))[0]);
}

export async function releaseEscalation(db: Db, id: number): Promise<void> {
  await db.query("UPDATE escalations SET status='abierta' WHERE id=$1 AND status='respondiendo'", [id]);
}

export async function answerEscalationRow(db: Db, id: number, answer: string): Promise<void> {
  await db.query("UPDATE escalations SET answer=$2, status='respondida', answered_at=now() WHERE id=$1", [id, answer]);
}

export async function listOpenEscalations(db: Db): Promise<Escalation[]> {
  return mapRows(await db.query("SELECT * FROM escalations WHERE status='abierta' ORDER BY id"));
}

export async function getEscalation(db: Db, id: number): Promise<Escalation | undefined> {
  return mapRow<Escalation>((await db.query('SELECT * FROM escalations WHERE id=$1', [id]))[0]);
}

export async function addFaq(db: Db, question: string, answer: string): Promise<void> {
  await db.query('INSERT INTO faq (question, answer) VALUES ($1,$2)', [question, answer]);
}

export async function listFaq(db: Db): Promise<Faq[]> {
  return mapRows(await db.query('SELECT * FROM faq ORDER BY id'));
}

// ---------- opt-out ----------

export async function isOptedOut(db: Db, waId: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM opt_outs WHERE wa_id=$1', [waId])).length > 0;
}

export async function applyOptOut(db: Db, prospectId: number, reason: string): Promise<void> {
  const p = await getProspect(db, prospectId);
  if (!p) return;
  if (p.waId) {
    await db.query('INSERT INTO opt_outs (wa_id, reason) VALUES ($1,$2) ON CONFLICT (wa_id) DO NOTHING', [p.waId, reason]);
  }
  await db.query('DELETE FROM messages WHERE prospect_id=$1', [prospectId]);
  await db.query(
    `UPDATE prospects SET status='baja', status_reason=$2, name='(baja)', email=NULL, phone_raw=NULL, website=NULL, updated_at=now()
     WHERE id=$1`,
    [prospectId, reason],
  );
}

// ---------- manuales ----------

export async function getActiveManual(db: Db, kind: ManualKind): Promise<string> {
  const r = await db.query<{ content: string }>('SELECT content FROM manual_versions WHERE kind=$1 AND active ORDER BY id DESC LIMIT 1', [kind]);
  return r[0]?.content ?? '';
}

export async function addManualVersion(db: Db, kind: ManualKind, content: string, source: 'archivo' | 'propuesta'): Promise<number> {
  await db.query('UPDATE manual_versions SET active=false WHERE kind=$1 AND active', [kind]);
  const r = await db.query<{ id: number }>(
    'INSERT INTO manual_versions (kind, content, source) VALUES ($1,$2,$3) RETURNING id',
    [kind, content, source],
  );
  return r[0].id;
}

export async function listManualVersions(db: Db, kind: ManualKind): Promise<ManualVersion[]> {
  return mapRows(await db.query('SELECT * FROM manual_versions WHERE kind=$1 ORDER BY id DESC', [kind]));
}

// ---------- variantes de apertura ----------

export async function listVariants(db: Db, status?: VariantStatus): Promise<Variant[]> {
  return mapRows(status
    ? await db.query('SELECT * FROM opener_variants WHERE status=$1 ORDER BY id', [status])
    : await db.query('SELECT * FROM opener_variants ORDER BY id'));
}

export async function addVariant(db: Db, template: string, status: 'activa' | 'candidata', proposalId?: number): Promise<number> {
  const r = await db.query<{ id: number }>(
    'INSERT INTO opener_variants (template, status, proposal_id) VALUES ($1,$2,$3) RETURNING id',
    [template, status, proposalId ?? null],
  );
  return r[0].id;
}

export async function setVariantStatus(db: Db, id: number, status: VariantStatus): Promise<void> {
  await db.query('UPDATE opener_variants SET status=$2 WHERE id=$1', [id, status]);
}

// ---------- propuestas ----------

export async function addProposal(
  db: Db,
  p: { kind: ProposalKind; summary: string; evidence: string; proposedContent: string; targetId?: number },
): Promise<number> {
  const r = await db.query<{ id: number }>(
    'INSERT INTO proposals (kind, summary, evidence, proposed_content, target_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [p.kind, p.summary, p.evidence, p.proposedContent, p.targetId ?? null],
  );
  return r[0].id;
}

export async function listProposals(db: Db, status?: string): Promise<Proposal[]> {
  return mapRows(status
    ? await db.query('SELECT * FROM proposals WHERE status=$1 ORDER BY id', [status])
    : await db.query('SELECT * FROM proposals ORDER BY id'));
}

export async function decideProposal(db: Db, id: number, status: 'aprobada' | 'rechazada'): Promise<void> {
  await db.query('UPDATE proposals SET status=$2, decided_at=now() WHERE id=$1', [id, status]);
}

export async function getProposal(db: Db, id: number): Promise<Proposal | undefined> {
  return mapRow<Proposal>((await db.query('SELECT * FROM proposals WHERE id=$1', [id]))[0]);
}

// ---------- reuniones ----------

export async function addMeeting(db: Db, m: NewMeeting): Promise<number> {
  const r = await db.query<{ id: number }>(
    'INSERT INTO meetings (prospect_id, starts_at, ends_at, calendar_event_id, meet_url) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [m.prospectId, m.startsAt, m.endsAt, m.calendarEventId ?? null, m.meetUrl ?? null],
  );
  return r[0].id;
}

export async function listUpcomingMeetings(db: Db, now: Date): Promise<Meeting[]> {
  return mapRows(await db.query('SELECT * FROM meetings WHERE starts_at >= $1 ORDER BY starts_at', [now]));
}

// ---------- eventos y kv ----------

export async function logEvent(db: Db, type: string, payload: object): Promise<void> {
  await db.query('INSERT INTO events (type, payload) VALUES ($1,$2)', [type, JSON.stringify(payload)]);
}

export async function listEvents(db: Db, limit: number): Promise<EventRow[]> {
  return mapRows(await db.query('SELECT * FROM events ORDER BY id DESC LIMIT $1', [limit]));
}

export async function kvGet<T>(db: Db, key: string): Promise<T | undefined> {
  const r = await db.query<{ value: T }>('SELECT value FROM kv WHERE key=$1', [key]);
  return r[0]?.value;
}

export async function kvSet(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    'INSERT INTO kv (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
    [key, JSON.stringify(value)],
  );
}

// ---------- seed ----------

export async function seedKnowledge(db: Db, contentDir: string): Promise<void> {
  const files: [ManualKind, string][] = [
    ['ventas', 'manual-ventas.md'],
    ['producto', 'producto-crm.md'],
    ['estilo', 'estilo.md'],
  ];
  for (const [kind, file] of files) {
    if ((await db.query('SELECT 1 FROM manual_versions WHERE kind=$1 AND active', [kind])).length === 0) {
      await addManualVersion(db, kind, readFileSync(join(contentDir, file), 'utf8'), 'archivo');
    }
  }
  if ((await listVariants(db, 'activa')).length === 0) {
    await addVariant(db, readFileSync(join(contentDir, 'apertura.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim(), 'activa');
  }
}

// ---------- ids de WhatsApp ----------

/** ¿Este id de mensaje de WhatsApp fue enviado por el sistema (outbox o mensajes)? */
export async function isSystemWaMessageId(db: Db, waMessageId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM outbox WHERE wa_message_id=$1
     UNION ALL SELECT 1 FROM messages WHERE wa_message_id=$1 AND direction='out' AND author='agent' LIMIT 1`,
    [waMessageId],
  );
  return r.length > 0;
}

export async function countOptOutsSince(db: Db, since: Date): Promise<number> {
  const r = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM opt_outs WHERE created_at >= $1', [since]);
  return r[0].n;
}

// ---------- pipeline (solo lectura) ----------

export async function countProspectsByStatus(db: Db): Promise<Record<string, number>> {
  const r = await db.query<{ status: string; n: number }>('SELECT status, count(*)::int AS n FROM prospects GROUP BY status');
  return Object.fromEntries(r.map((x) => [x.status, x.n]));
}

export async function countOutboxByStatus(db: Db, sentSince: Date): Promise<{ pendiente: number; enviadoHoy: number; bloqueado: number; fallido: number }> {
  const r = await db.query<{ pendiente: number; enviado_hoy: number; bloqueado: number; fallido: number }>(
    `SELECT count(*) FILTER (WHERE status='pendiente')::int AS pendiente,
            count(*) FILTER (WHERE status='enviado' AND sent_at >= $1)::int AS enviado_hoy,
            count(*) FILTER (WHERE status='fallido' AND error='bloqueado')::int AS bloqueado,
            count(*) FILTER (WHERE status='fallido' AND error IS DISTINCT FROM 'bloqueado')::int AS fallido
     FROM outbox`,
    [sentSince],
  );
  return { pendiente: r[0].pendiente, enviadoHoy: r[0].enviado_hoy, bloqueado: r[0].bloqueado, fallido: r[0].fallido };
}

/** Últimos mensajes de todos los prospectos; `outboxStatus` solo si el saliente se asocia por wa_message_id (los enviados). */
export async function listRecentMessages(db: Db, limit: number): Promise<(Message & { prospectName: string; outboxStatus: string | null })[]> {
  return mapRows(await db.query(
    `SELECT m.*, p.name AS prospect_name, o.status AS outbox_status
     FROM messages m
     JOIN prospects p ON p.id = m.prospect_id
     LEFT JOIN outbox o ON m.direction='out' AND m.wa_message_id IS NOT NULL AND o.wa_message_id = m.wa_message_id
     ORDER BY m.id DESC LIMIT $1`,
    [limit],
  ));
}

export async function listPendingOutbox(db: Db, limit: number): Promise<OutboxItem[]> {
  return mapRows(await db.query("SELECT * FROM outbox WHERE status='pendiente' ORDER BY send_after, id LIMIT $1", [limit]));
}
