import { DateTime } from 'luxon';
import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import { join } from 'node:path';
import { CITIES } from '../agents/buscador/cities.js';
import { CORRIDAS_FILE, ESTADO_FILE, PROSPECTOS_FILE, readJson, type Psicologo } from '../agents/buscador/archivo.js';
import type { CorridaResult } from '../agents/buscador/corrida.js';
import {
  countContactedSince, countOutboxByStatus, countProspectsByStatus, kvGet, listEvents, listFaq, listManualVersions,
  listOpenEscalations, listPendingOutbox, listProposals, listRecentMessages, listUpcomingMeetings, listVariants,
  type EventRow, type ManualKind, type OutboxItem, type Message, type Status,
} from '../db/repo.js';
import { Dot, Layout, STATUS_LABELS } from './views.js';

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

/** Lo que el Buscador dejó en data/prospectos.json, cruzado con la base. */
export interface BuscadorArchivo {
  total: number;
  enBase: number;
  pendientes: number;
  descartados: Record<string, number>;
  /** Los últimos 20, más nuevos primero. */
  ultimos: (Psicologo & { estado: string })[];
  ultimaCorrida: CorridaResult | null;
}

/** Cuántos psicólogos del .json se listan en el hub. */
const ULTIMOS = 20;

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
  buscador: AgentInfo & { lastRun: { revisados?: number; cargados?: number; descartes?: Record<string, number>; at?: string } | null };
  buscadorArchivo: BuscadorArchivo;
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
    if (e.type === 'buscador_import') lastRunEvent ??= e;
  }

  const manuals: ManualInfo[] = [];
  for (const kind of ['ventas', 'producto', 'estilo'] as ManualKind[]) {
    const v = (await listManualVersions(db, kind)).find((x) => x.active);
    manuals.push({ kind, chars: v?.content.length ?? 0, createdAt: v?.createdAt ?? null });
  }
  const dataDir = config.dataDir ?? 'data';
  const estado = readJson<{ ciudad?: unknown }>(join(dataDir, ESTADO_FILE), {});
  const city = CITIES[typeof estado.ciudad === 'number' ? estado.ciudad : 0];
  const buscadorArchivo = await loadBuscadorArchivo(db, dataDir);
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
    buscadorArchivo,
    vendedor: agents.vendedor,
    agenda: agents.agenda,
    orquestador: agents.orquestador,
    analista: agents.analista,
    messages: await listRecentMessages(db, 50),
    outboxPendiente: await listPendingOutbox(db, 20),
    events: allEvents.slice(0, 30),
  };
}

async function loadBuscadorArchivo(db: Db, dataDir: string): Promise<BuscadorArchivo> {
  const raw = readJson<unknown>(join(dataDir, PROSPECTOS_FILE), []);
  const lista = (Array.isArray(raw) ? raw : []).filter((p): p is Psicologo => Boolean(p) && typeof p.waId === 'string');
  const enDb = new Set((await db.query<{ wa_id: string }>('SELECT wa_id FROM prospects WHERE wa_id IS NOT NULL')).map((r) => r.wa_id));
  const desc = (await kvGet<Record<string, string>>(db, 'importador_descartados')) ?? {};
  const descartados: Record<string, number> = {};
  let enBase = 0;
  const conEstado = lista.map((p) => {
    if (enDb.has(p.waId)) { enBase++; return { ...p, estado: 'en la base' }; }
    const why = desc[p.waId];
    if (why) { descartados[why] = (descartados[why] ?? 0) + 1; return { ...p, estado: `descartado (${why})` }; }
    return { ...p, estado: 'pendiente' };
  });
  const nDesc = Object.values(descartados).reduce((a, b) => a + b, 0);
  const corridas = readJson<unknown>(join(dataDir, CORRIDAS_FILE), []);
  return {
    total: lista.length,
    enBase,
    pendientes: lista.length - enBase - nDesc,
    descartados,
    ultimos: conEstado.slice(-ULTIMOS).reverse(),
    ultimaCorrida: Array.isArray(corridas) && corridas.length ? (corridas[corridas.length - 1] as CorridaResult) : null,
  };
}

const PIPELINE_CSS = `
.frame{background:var(--surface) linear-gradient(180deg,oklch(1 0 0/2.5%),transparent 120px);border:1px solid var(--border);border-radius:var(--r-xl);margin-bottom:24px;overflow:hidden}
.frame-bar{display:flex;align-items:center;gap:8px;padding:12px 20px;border-bottom:1px solid var(--border);font:400 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.frame-bar i{width:8px;height:8px;border-radius:50%;background:oklch(1 0 0/10%);display:inline-block}
.frame-bar span{margin-left:12px;display:flex;align-items:center;gap:8px}
.frame-body{padding:20px}
.frame-body h3{display:none}
.flow{display:flex;flex-wrap:wrap;align-items:stretch;margin-bottom:14px}
.flow:last-child{margin-bottom:0}
.node{border:1px solid var(--border);background:oklch(1 0 0/.02);border-radius:var(--r-lg);padding:10px 12px;min-width:0;flex:1 1 96px;font-size:13px;overflow-wrap:anywhere;line-height:1.45;transition:border-color .2s var(--ease),background-color .2s var(--ease)}
.node:hover{border-color:oklch(1 0 0/15%);background:oklch(1 0 0/.035)}
.node b{display:block;font:400 10px/1.4 var(--mono);text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin-bottom:6px}
.node.lauri{border-color:oklch(.72 .15 250/30%);background:oklch(.72 .15 250/.05)}
.node.lauri b{color:var(--fg)}
.node.lauri b::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--signal);box-shadow:0 0 8px var(--signal);margin-right:8px;vertical-align:1px}
.node.ext{border-style:dashed;background:transparent;color:var(--muted)}
.arrow{align-self:center;flex:0 0 14px;height:1px;background:oklch(1 0 0/15%);font-size:0}
.agents{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:20px;margin-bottom:20px}
.agents .card{margin:0}
.agents .card > div:first-of-type{color:oklch(.965 .004 262/90%);margin-bottom:4px}
.agents ul,.agents ol{margin:0;padding-left:18px;font-size:13px;line-height:1.55;color:var(--muted)}
.agents h3{font-size:17px}
.err{display:flex;gap:8px;align-items:baseline;color:var(--fg)}
.err::before{content:'';width:6px;height:6px;flex:none;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--fg)}
.fun{display:grid;grid-template-columns:160px 1fr 48px;align-items:center;gap:16px;margin:10px 0;font-size:13px}
.fun span{color:var(--muted)}
.fun .track{height:6px;border-radius:9px;background:oklch(1 0 0/.04);overflow:hidden}
.fun .bar{height:100%;border-radius:9px;background:var(--signal);min-width:2px;transform-origin:left;animation:crece .8s var(--ease) both}
@keyframes crece{from{transform:scaleX(0)}}
.fun.side .bar{background:var(--chart2)}
.fun b{font:400 11px/1 var(--mono);text-align:right}
.ev td{color:var(--muted)}
.ev.error td{color:var(--fg)}
.ev.error td.mono:first-of-type::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--fg);margin-right:8px;vertical-align:1px}
.scroll{overflow-x:auto}
@media(max-width:860px){.flow{flex-direction:column}.arrow{flex:0 0 14px;width:1px;height:14px;margin-left:18px}.node{flex:none}.fun{grid-template-columns:110px 1fr 36px}.frame-body{padding:16px}}
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
  const ba = d.buscadorArchivo;
  const corrida = ba.ultimaCorrida;
  const funnel = (s: Status, side = false) => (
    <div class={side ? 'fun side' : 'fun'}>
      <span>{STATUS_LABELS[s]}</span>
      <div class="track"><div class="bar" style={`width:${((d.statusCounts[s] ?? 0) / max) * 100}%`}></div></div>
      <b>{d.statusCounts[s] ?? 0}</b>
    </div>
  );
  return (
    <div class="page">
      <style dangerouslySetInnerHTML={{ __html: PIPELINE_CSS }} />
      <div class="frame">
        <div class="frame-bar"><i></i><i></i><i></i><span><Dot tone="signal" pulse />Flujo de agentes en vivo</span></div>
        <div class="frame-body">
        <h3>Flujo</h3>
        <div class="flow">
          <Node title="Web (navegador)" n="buscador web y sitios de psicólogos" cls="ext" /><Arrow />
          <Node title="Buscador (Claude en la Mac, cada hora)" n={`${ba.total} en prospectos.json`} /><Arrow />
          <Node title="Importador (worker, cada 10 min)" n={`${ba.pendientes} pendientes`} /><Arrow />
          <Node title="Base de prospectos" n={`${d.totalProspects} encontrados`} /><Arrow />
          <Node title={`Orquestador (cada minuto, máx ${config.dailyNewContacts}/día)`} n={`${d.contactsToday} contactos hoy`} /><Arrow />
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
      </div>

      <div class="agents">
        <Agent name="Buscador" does="Un agente de Claude busca psicólogos con el navegador desde la Mac y los guarda en data/prospectos.json. El worker los pasa a la base (WhatsApp, No Llame y bajas) cada 10 minutos."
          when="cada hora en la Mac (o a mano con npm run buscador); importación cada 10 min"
          models={['claude -p (sonnet) + navegador']} a={d.buscador} fmt={fmt}
          info={[
            `Próxima ciudad: ${d.cursorCity}`,
            `prospectos.json: ${ba.total} (en la base ${ba.enBase}, pendientes ${ba.pendientes}, descartados ${oneLine(ba.descartados)})`,
            corrida ? `Última corrida (${fmt(new Date(corrida.at))}): ${corrida.ciudad}, trajo ${corrida.hallados}, guardó ${corrida.guardados}` : 'Todavía no hubo corridas',
          ]}
          extra={run ? `revisados ${run.revisados ?? 0}, cargados ${run.cargados ?? 0}, descartes ${oneLine(run.descartes)}` : undefined} />
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

      <div class="card scroll">
        <h3>Psicólogos encontrados (data/prospectos.json, últimos {ULTIMOS})</h3>
        {ba.ultimos.length === 0 ? <div>El Buscador todavía no encontró a nadie. Corré <span class="mono">npm run buscador</span> en la Mac.</div> : (
          <table>
            <thead><tr><th>Encontrado</th><th>Nombre</th><th>Celular</th><th>Email</th><th>Ciudad</th><th>Página</th><th>Estado</th></tr></thead>
            <tbody>
              {ba.ultimos.map((p) => (
                <tr>
                  <td class="t">{fmt(new Date(p.encontradoEl))}</td>
                  <td>{p.nombre}</td>
                  <td class="mono">{p.celular}</td>
                  <td>{p.email ?? '—'}</td>
                  <td>{p.ciudad}</td>
                  <td>{/^https?:\/\//i.test(p.pagina) ? <a href={p.pagina} target="_blank" rel="noopener noreferrer">{cut(p.pagina, 40)}</a> : cut(String(p.pagina), 40)}</td>
                  <td>{p.estado}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
                <td class="t">{fmt(m.createdAt)}</td>
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
              {d.outboxPendiente.map((o) => <tr><td class="mono">{o.toWaId}</td><td class="t">{fmt(o.sendAfter)}</td><td>{o.kind}</td></tr>)}
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
                <td class="t">{fmt(e.createdAt)}</td><td class="mono">{e.type}</td><td class="mono">{oneLine(e.payload)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PipelinePage(p: { d: PipelineData; config: Config; fmt: (x: Date) => string; chrome: { banners: string[]; attention: number; wa: string; active: string } }) {
  return (
    <Layout title="Pipeline de agentes" eyebrow="Agentes en vivo" description="Qué hace cada agente, con qué modelo y qué pasó en las últimas 24 horas." refresh {...p.chrome}>
      <PipelineView d={p.d} config={p.config} fmt={p.fmt} />
    </Layout>
  );
}
