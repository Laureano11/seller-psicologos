import { DateTime } from 'luxon';
import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import { CITIES } from '../agents/buscador/cities.js';
import {
  countContactedSince, countOutboxByStatus, countProspectsByStatus, kvGet, listEvents, listFaq, listManualVersions,
  listOpenEscalations, listPendingOutbox, listProposals, listRecentMessages, listUpcomingMeetings, listVariants,
  type EventRow, type ManualKind, type OutboxItem, type Message, type Status,
} from '../db/repo.js';
import { Layout, STATUS_LABELS } from './views.js';

export const MAIN_STATUSES: Status[] = ['encontrado', 'contactado', 'conversando', 'interesado', 'reunion_agendada', 'listo_para_cerrar'];
export const SIDE_STATUSES: Status[] = ['rechazado', 'sin_respuesta', 'baja', 'descartado'];

type AgentKey = 'buscador' | 'vendedor' | 'agenda' | 'orquestador' | 'analista';

const AGENT_OF_TYPE = (e: EventRow): AgentKey | null => {
  const t = e.type;
  if (t.startsWith('buscador_') || t === 'dnc_archivo_faltante') return 'buscador';
  if (t.startsWith('vendedor_') || t === 'followup_error') return 'vendedor';
  if (t === 'mail_error') return 'agenda';
  if (t === 'analisis_error' || t === 'variante_retirada') return 'analista';
  if (t === 'llm_error') {
    const a = e.payload?.agent;
    return a === 'buscador' || a === 'vendedor' || a === 'analista' ? a : null;
  }
  if (t === 'error' || t === 'outbox_fallido' || t.startsWith('wa_')) return 'orquestador';
  return null;
};

export const isErrorEvent = (type: string) =>
  type === 'error' || type.endsWith('_error') || type === 'outbox_fallido' || type === 'wa_desconectado';

export interface AgentInfo {
  lastEvent: EventRow | null;
  errors: EventRow[];
}

export interface ManualInfo { kind: ManualKind; chars: number; createdAt: Date | null }

export interface PipelineData {
  now: Date;
  statusCounts: Record<string, number>;
  totalProspects: number;
  outbox: { pendiente: number; enviadoHoy: number; bloqueado: number; fallido: number };
  escalacionesAbiertas: number;
  reuniones: number;
  propuestasPendientes: number;
  contactsToday: number;
  contactsSinceProposal: number;
  waState: string;
  pausaNuevos: boolean;
  cursorCity: string;
  manuals: ManualInfo[];
  faqCount: number;
  variantActiva: string | null;
  variantCandidata: string | null;
  buscador: AgentInfo & { lastRun: { found?: number; inserted?: number; skipped?: Record<string, number>; at?: string } | null };
  vendedor: AgentInfo;
  agenda: AgentInfo;
  orquestador: AgentInfo;
  analista: AgentInfo;
  messages: Awaited<ReturnType<typeof listRecentMessages>>;
  outboxPendiente: OutboxItem[];
  events: EventRow[];
}

export async function loadPipelineData(db: Db, config: Config, now: Date): Promise<PipelineData> {
  const tz = config.tz ?? 'America/Argentina/Buenos_Aires';
  const startOfDay = DateTime.fromJSDate(now, { zone: tz }).startOf('day').toJSDate();
  const dayAgo = now.getTime() - 24 * 3600_000;

  const statusCounts = await countProspectsByStatus(db);
  const proposals = await listProposals(db);
  const lastProposalAt = proposals.reduce<Date | null>((m, p) => (!m || p.createdAt > m ? p.createdAt : m), null);
  const allEvents = await listEvents(db, 500);

  const agents: Record<AgentKey, AgentInfo> = {
    buscador: { lastEvent: null, errors: [] }, vendedor: { lastEvent: null, errors: [] }, agenda: { lastEvent: null, errors: [] },
    orquestador: { lastEvent: null, errors: [] }, analista: { lastEvent: null, errors: [] },
  };
  let lastRunEvent: EventRow | null = null;
  for (const e of allEvents) { // más recientes primero
    const a = AGENT_OF_TYPE(e);
    if (!a) continue;
    agents[a].lastEvent ??= e;
    if (isErrorEvent(e.type) && new Date(e.createdAt).getTime() >= dayAgo) agents[a].errors.push(e);
    if (e.type === 'buscador_run') lastRunEvent ??= e;
  }

  const manuals: ManualInfo[] = [];
  for (const kind of ['ventas', 'producto', 'estilo'] as ManualKind[]) {
    const v = (await listManualVersions(db, kind)).find((x) => x.active);
    manuals.push({ kind, chars: v?.content.length ?? 0, createdAt: v?.createdAt ?? null });
  }
  const cursor = await kvGet<number>(db, 'buscador_cursor');
  const city = CITIES[typeof cursor === 'number' ? cursor : 0];
  const wa = await kvGet<{ state: string }>(db, 'wa_status');

  return {
    now,
    statusCounts,
    totalProspects: Object.values(statusCounts).reduce((a, b) => a + b, 0),
    outbox: await countOutboxByStatus(db, startOfDay),
    escalacionesAbiertas: (await listOpenEscalations(db)).length,
    reuniones: (await listUpcomingMeetings(db, now)).length,
    propuestasPendientes: proposals.filter((p) => p.status === 'pendiente').length,
    contactsToday: await countContactedSince(db, startOfDay),
    contactsSinceProposal: await countContactedSince(db, lastProposalAt ?? new Date(0)),
    waState: wa?.state ?? 'sin estado',
    pausaNuevos: Boolean(await kvGet(db, 'pausa_nuevos')),
    cursorCity: city ? `${city.city}, ${city.province}` : '—',
    manuals,
    faqCount: (await listFaq(db)).length,
    variantActiva: (await listVariants(db, 'activa'))[0]?.template ?? null,
    variantCandidata: (await listVariants(db, 'candidata'))[0]?.template ?? null,
    buscador: { ...agents.buscador, lastRun: lastRunEvent?.payload ?? null },
    vendedor: agents.vendedor,
    agenda: agents.agenda,
    orquestador: agents.orquestador,
    analista: agents.analista,
    messages: await listRecentMessages(db, 50),
    outboxPendiente: await listPendingOutbox(db, 20),
    events: allEvents.slice(0, 30),
  };
}

const PIPELINE_CSS = `
.flow{display:flex;flex-wrap:wrap;align-items:stretch;gap:6px;margin-bottom:10px}
.node{background:#fff;border:2px solid #cfd6dd;border-radius:8px;padding:6px 10px;min-width:130px;flex:1 1 130px}
.node b{display:block;font-size:12px;color:#556}
.node.lauri{border-color:#e08a00;background:#fff4dd}
.node.ext{background:#eef2f6;border-style:dashed}
.arrow{align-self:center;font-weight:700;color:#778}
.agents{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:12px}
.agents .card{margin:0}
.agents ul{margin:4px 0;padding-left:18px}
.agents small{color:#556}
.err{color:#b00020}
.fun{display:flex;align-items:center;gap:8px;margin:3px 0}
.fun span{flex:0 0 140px}
.fun .bar{height:16px;background:#0b5fd1;border-radius:4px;min-width:2px}
.fun.side .bar{background:#8a8f98}
.ev.error td{background:#fde2e2}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.scroll{overflow-x:auto}
@media(max-width:760px){.flow{flex-direction:column}.arrow{transform:rotate(90deg);align-self:center}.node{flex:none}}
`;

const AUTHOR: Record<Message['author'], string> = { prospect: 'Psicólogo', agent: 'Agente', lauri: 'Lauri' };
const OUTBOX_LABEL: Record<string, string> = { enviado: 'enviado', pendiente: 'pendiente', fallido: 'fallido' };

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const oneLine = (p: unknown) => cut(JSON.stringify(p ?? {}), 160);

function Node(p: { title: string; n?: string | number; cls?: string }) {
  return <div class={`node ${p.cls ?? ''}`}><b>{p.title}</b>{p.n ?? ''}</div>;
}
const Arrow = () => <span class="arrow">→</span>;

function Agent(p: { name: string; does: string; when: string; models: string[] | null; info: (string | null)[]; a: AgentInfo; fmt: (d: Date) => string; extra?: string }) {
  return (
    <div class="card">
      <h3>{p.name}</h3>
      <div>{p.does}</div>
      <small>Cuándo corre: {p.when}</small>
      <h4>Modelos</h4>
      {p.models && p.models.length > 0
        ? <ol>{p.models.map((m) => <li class="mono">{m}</li>)}</ol>
        : <div>{p.models ? 'Sin modelos configurados' : 'sin modelo'}</div>}
      <h4>Información que usa</h4>
      <ul>{p.info.filter((x): x is string => x !== null).map((x) => <li>{x}</li>)}</ul>
      <h4>Última actividad</h4>
      {p.a.lastEvent
        ? <div><span class="mono">{p.a.lastEvent.type}</span> · {p.fmt(p.a.lastEvent.createdAt)}<br /><small>{p.extra ?? oneLine(p.a.lastEvent.payload)}</small></div>
        : <div>Sin actividad registrada</div>}
      <h4>Errores (24 h): {p.a.errors.length}</h4>
      {p.a.errors.slice(0, 3).map((e) => <div class="err"><small>{p.fmt(e.createdAt)} · {e.type} · {oneLine(e.payload)}</small></div>)}
    </div>
  );
}

export function PipelineView({ d, config, fmt }: { d: PipelineData; config: Config; fmt: (x: Date) => string }) {
  const max = Math.max(1, ...Object.values(d.statusCounts));
  const manualTxt = d.manuals.map((m) => `${m.kind}: ${m.chars} car.${m.createdAt ? ` (${fmt(m.createdAt)})` : ''}`).join(' · ');
  const run = d.buscador.lastRun;
  const funnel = (s: Status, side = false) => (
    <div class={side ? 'fun side' : 'fun'}>
      <span>{STATUS_LABELS[s]}</span>
      <div class="bar" style={`width:${((d.statusCounts[s] ?? 0) / max) * 60}%`}></div>
      <b>{d.statusCounts[s] ?? 0}</b>
    </div>
  );
  return (
    <div class="page">
      <style>{PIPELINE_CSS}</style>
      <h2>Pipeline de agentes</h2>

      <div class="card">
        <h3>Flujo</h3>
        <div class="flow">
          <Node title="Fuentes" n="Google Places, sitios web" cls="ext" /><Arrow />
          <Node title="Buscador (9:00)" /><Arrow />
          <Node title="Base de prospectos" n={`${d.totalProspects} encontrados`} /><Arrow />
          <Node title="Orquestador (cada minuto, máx 5/día)" n={`${d.contactsToday} contactos hoy`} /><Arrow />
          <Node title="Vendedor" /><Arrow />
          <Node title="Outbox" n={`${d.outbox.pendiente} pendientes / ${d.outbox.enviadoHoy} enviados hoy / ${d.outbox.bloqueado} bloqueados`} /><Arrow />
          <Node title="WhatsApp" n={d.waState} cls="ext" /><Arrow />
          <Node title="Psicólogo" cls="ext" />
        </div>
        <div class="flow">
          <Node title="Psicólogo (respuesta)" cls="ext" /><Arrow />
          <Node title="Lista blanca" /><Arrow />
          <Node title="Vendedor (espera 30 s)" />
        </div>
        <div class="flow">
          <Node title="Vendedor → Agenda (Calendar + Gmail)" n={`${d.reuniones} reuniones`} /><Arrow />
          <Node title="Vendedor → Escalación → Lauri (hub + WhatsApp a sí mismo)" n={`${d.escalacionesAbiertas} abiertas`} cls="lauri" /><Arrow />
          <Node title="Vendedor → Listo para cerrar → Lauri" n={d.statusCounts.listo_para_cerrar ?? 0} cls="lauri" />
        </div>
        <div class="flow">
          <Node title="Analista (lunes 8:00)" /><Arrow />
          <Node title="Propuestas → Lauri aprueba" n={`${d.propuestasPendientes} pendientes`} cls="lauri" /><Arrow />
          <Node title="Manual / aperturas" />
        </div>
      </div>

      <div class="agents">
        <Agent name="Buscador" does="Busca psicólogos en Google Places y sus sitios web y los carga como prospectos." when="todos los días a las 9:00"
          models={config.llm.buscador} a={d.buscador} fmt={fmt}
          info={[`Ciudad actual (cursor): ${d.cursorCity}`, `Fuentes: sitios web${config.googlePlacesKey ? ', Google Places' : ''}`]}
          extra={run ? `found ${run.found ?? 0}, inserted ${run.inserted ?? 0}, skipped ${oneLine(run.skipped)}` : undefined} />
        <Agent name="Vendedor" does="Conversa con los psicólogos por WhatsApp, responde dudas y escala lo que no sabe." when="al contactar y al responder cada prospecto (espera 30 s)"
          models={config.llm.vendedor} a={d.vendedor} fmt={fmt}
          info={[`Manuales activos — ${manualTxt}`, `FAQ: ${d.faqCount}`, `Apertura activa: ${d.variantActiva ? cut(d.variantActiva, 80) : '—'}`, `Apertura candidata: ${d.variantCandidata ? cut(d.variantCandidata, 80) : '—'}`]} />
        <Agent name="Agenda" does="Agenda reuniones en Calendar y manda el mail de confirmación por Gmail." when="cuando el prospecto acepta un horario"
          models={null} a={d.agenda} fmt={fmt} info={[`Reuniones próximas: ${d.reuniones}`]} />
        <Agent name="Orquestador" does="Decide a quién contactar, hace seguimientos y envía el outbox." when="cada minuto"
          models={null} a={d.orquestador} fmt={fmt}
          info={[`Ventana de envío: ${config.sendWindow.start}–${config.sendWindow.end}`, `Límite diario: ${config.dailyNewContacts}`, `Contactos hoy: ${d.contactsToday}`, `Pausa de nuevos: ${d.pausaNuevos ? 'sí' : 'no'}`, `WhatsApp: ${d.waState}`]} />
        <Agent name="Analista" does="Compara aperturas y propone mejoras que Lauri aprueba." when="lunes a las 8:00"
          models={config.llm.analista} a={d.analista} fmt={fmt}
          info={[`Umbral A/B: ${config.abMinPerVariant} contactos por variante`, `Contactos desde la última propuesta: ${d.contactsSinceProposal}`]} />
      </div>

      <div class="card">
        <h3>Embudo de estados</h3>
        {MAIN_STATUSES.map((s) => funnel(s))}
        <hr />
        {SIDE_STATUSES.map((s) => funnel(s, true))}
      </div>

      <div class="card scroll">
        <h3>Registro de mensajes (últimos 50)</h3>
        <table>
          <thead><tr><th>Fecha</th><th>Prospecto</th><th>Dir.</th><th>Autor</th><th>Texto</th><th>Outbox</th></tr></thead>
          <tbody>
            {d.messages.map((m) => (
              <tr>
                <td>{fmt(m.createdAt)}</td>
                <td><a href={`/p/${m.prospectId}`}>{m.prospectName}</a></td>
                <td>{m.direction === 'in' ? 'Entrante' : 'Saliente'}</td>
                <td>{AUTHOR[m.author]}</td>
                <td>{cut(m.body, 200)}</td>
                <td>{m.direction === 'out' && m.outboxStatus ? (OUTBOX_LABEL[m.outboxStatus] ?? m.outboxStatus) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="card scroll">
        <h3>Outbox pendiente</h3>
        {d.outboxPendiente.length === 0 ? <div>No hay envíos pendientes.</div> : (
          <table>
            <thead><tr><th>Destino</th><th>Enviar después de</th><th>Tipo</th></tr></thead>
            <tbody>
              {d.outboxPendiente.map((o) => <tr><td class="mono">{o.toWaId}</td><td>{fmt(o.sendAfter)}</td><td>{o.kind}</td></tr>)}
            </tbody>
          </table>
        )}
      </div>

      <div class="card scroll">
        <h3>Línea de tiempo de eventos (últimos 30)</h3>
        <table>
          <tbody>
            {d.events.map((e) => (
              <tr class={isErrorEvent(e.type) ? 'ev error' : 'ev'}>
                <td>{fmt(e.createdAt)}</td><td class="mono">{e.type}</td><td class="mono">{oneLine(e.payload)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PipelinePage(p: { d: PipelineData; config: Config; fmt: (x: Date) => string; banners: string[] }) {
  return (
    <Layout title="Pipeline" refresh banners={p.banners}>
      <PipelineView d={p.d} config={p.config} fmt={p.fmt} />
    </Layout>
  );
}
