import type { Child } from 'hono/jsx';
import type { Escalation, EventRow, ManualVersion, Meeting, Message, Prospect, Proposal, Status } from '../db/repo.js';
import type { VariantStat } from '../learning/stats.js';

export const STATUS_LABELS: Record<Status, string> = {
  encontrado: 'Encontrado',
  contactado: 'Contactado',
  conversando: 'Conversando',
  interesado: 'Interesado',
  reunion_agendada: 'Reunión agendada',
  listo_para_cerrar: 'Listo para cerrar',
  rechazado: 'Rechazado',
  sin_respuesta: 'Sin respuesta',
  baja: 'Baja',
  descartado: 'Descartado',
};

const CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;color:#1c1e21;font-size:15px;line-height:1.4}
a{color:#0b5fd1;text-decoration:none}
nav{background:#1c2b3a;padding:10px 14px;display:flex;gap:16px;flex-wrap:wrap}
nav a{color:#fff;font-weight:600}
.metrics{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px}
.metric{background:#fff;border-radius:8px;padding:8px 12px;min-width:110px;flex:1 1 110px;box-shadow:0 1px 2px #0002}
.metric b{display:block;font-size:20px}
.metric span{font-size:12px;color:#555}
.banner{margin:8px 14px;padding:10px 12px;border-radius:8px;background:#fff3cd;border:1px solid #e0b100}
.banner.error{background:#fde2e2;border-color:#d33}
.cols{display:flex;gap:12px;padding:0 14px 14px;align-items:flex-start}
.list{flex:0 0 320px;max-width:100%;background:#fff;border-radius:8px;box-shadow:0 1px 2px #0002;overflow:hidden}
.detail{flex:1;min-width:0}
.card{background:#fff;border-radius:8px;box-shadow:0 1px 2px #0002;padding:12px 14px;margin-bottom:12px}
.item{display:block;padding:10px 12px;border-bottom:1px solid #eee;color:inherit}
.item.sel{background:#e8f0fe}
.item small{display:block;color:#666}
.tag{display:inline-block;font-size:12px;background:#eef;border-radius:10px;padding:1px 8px;margin-left:4px}
.chat{display:flex;flex-direction:column;gap:6px}
.bubble{max-width:85%;padding:7px 10px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
.bubble small{display:block;font-size:11px;color:#667;margin-bottom:2px}
.bubble.prospect{background:#e9ebee;align-self:flex-start}
.bubble.agent{background:#d4f0d4;align-self:flex-end}
.bubble.lauri{background:#cfe3ff;align-self:flex-end}
textarea{width:100%;min-height:80px;font:inherit;padding:8px;border:1px solid #bbb;border-radius:6px}
button{font:inherit;padding:8px 14px;border:0;border-radius:6px;background:#0b5fd1;color:#fff;cursor:pointer}
button.no{background:#b33}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top}
pre{white-space:pre-wrap;word-wrap:break-word;background:#f4f5f7;padding:8px;border-radius:6px;margin:6px 0}
h1,h2,h3{margin:0 0 8px}
.page{padding:10px 14px}
@media(max-width:760px){.cols{flex-direction:column}.list{flex:none;width:100%}.detail{width:100%}.bubble{max-width:95%}}
`;

export function Layout(p: { title?: string; refresh?: boolean; banners?: string[]; error?: string; children?: Child }) {
  return (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {p.refresh ? <meta http-equiv="refresh" content="30" /> : null}
        <title>{p.title ?? 'Hub de ventas'}</title>
        <style>{CSS}</style>
      </head>
      <body>
        <nav>
          <a href="/">Prospectos</a>
          <a href="/mejoras">Mejoras</a>
          <a href="/sistema">Sistema</a>
        </nav>
        {p.error ? <div class="banner error">{p.error}</div> : null}
        {(p.banners ?? []).map((b) => <div class="banner">{b}</div>)}
        {p.children}
      </body>
    </html>
  );
}

export type Metrics = {
  encontrados: number; contactados: number; respondieron: number; listos: number;
  rechazados: number; sinRespuesta: number; teNecesitan: number;
};

export function computeMetrics(ps: Prospect[]): Metrics {
  return {
    encontrados: ps.length,
    contactados: ps.filter((p) => p.contactedAt).length,
    respondieron: ps.filter((p) => p.lastInboundAt).length,
    listos: ps.filter((p) => p.status === 'listo_para_cerrar').length,
    rechazados: ps.filter((p) => p.status === 'rechazado').length,
    sinRespuesta: ps.filter((p) => p.status === 'sin_respuesta').length,
    teNecesitan: ps.filter((p) => p.needsAttention).length,
  };
}

function Metric(p: { n: string | number; label: string }) {
  return <div class="metric"><b>{p.n}</b><span>{p.label}</span></div>;
}

export function MetricsBar({ m }: { m: Metrics }) {
  const pct = m.contactados > 0 ? Math.round((m.respondieron / m.contactados) * 100) : 0;
  return (
    <div class="metrics">
      <Metric n={m.encontrados} label="Encontrados" />
      <Metric n={m.contactados} label="Contactados" />
      <Metric n={`${m.respondieron} (${pct}%)`} label="Respondieron" />
      <Metric n={m.listos} label="Listos para cerrar" />
      <Metric n={m.rechazados} label="Rechazados" />
      <Metric n={m.sinRespuesta} label="Sin respuesta" />
      <Metric n={m.teNecesitan} label="Te necesitan" />
    </div>
  );
}

export function ProspectList({ prospects, selectedId }: { prospects: Prospect[]; selectedId?: number }) {
  return (
    <div class="list">
      {prospects.length === 0 ? <div class="item">Todavía no hay prospectos.</div> : null}
      {prospects.map((p) => (
        <a class={p.id === selectedId ? 'item sel' : 'item'} href={`/p/${p.id}`}>
          {p.needsAttention ? '🔔 ' : ''}<strong>{p.name}</strong>
          <small>{[p.city, STATUS_LABELS[p.status] ?? p.status].filter(Boolean).join(' · ')}</small>
        </a>
      ))}
    </div>
  );
}

const AUTHOR_LABEL = { prospect: 'Prospecto', agent: 'Agente', lauri: 'Lauri' } as const;

export function ProspectDetail(p: {
  prospect: Prospect; messages: Message[]; escalations: Escalation[]; fmt: (d: Date) => string;
}) {
  const { prospect: x } = p;
  const ev = x.evaluation as { stage?: unknown; summary?: unknown };
  return (
    <div class="detail">
      <div class="card">
        <h2>{x.name}</h2>
        <div>{STATUS_LABELS[x.status] ?? x.status}{x.statusReason ? ` (${x.statusReason})` : ''}{x.handedOff ? ' · tomado por Lauri' : ''}</div>
        <small>{[x.city, x.province, x.phoneRaw, x.email, x.website].filter(Boolean).join(' · ')}</small>
        {x.needsAttention ? <div>🔔 {x.needsAttention}</div> : null}
        {x.fitNotes ? <pre>{x.fitNotes}</pre> : null}
      </div>
      <div class="card">
        <h3>Evaluación del agente</h3>
        {ev.stage || ev.summary ? (
          <div>
            {ev.stage ? <div><strong>Etapa:</strong> {String(ev.stage)}</div> : null}
            {ev.summary ? <div>{String(ev.summary)}</div> : null}
          </div>
        ) : <div>Sin evaluación todavía.</div>}
      </div>
      {p.escalations.map((e) => (
        <div class="card">
          <h3>Te hace falta responder</h3>
          <pre>{e.question}</pre>
          <form method="post" action={`/escalations/${e.id}/answer`}>
            <textarea name="answer" required placeholder="Tu respuesta…"></textarea>
            <button type="submit">Responder</button>
          </form>
        </div>
      ))}
      <div class="card">
        <h3>Chat</h3>
        <div class="chat">
          {p.messages.length === 0 ? <div>Sin mensajes.</div> : null}
          {p.messages.map((m) => (
            <div class={`bubble ${m.author}`}>
              <small>{AUTHOR_LABEL[m.author]} · {p.fmt(m.createdAt)}</small>
              {m.body}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProposalsView(p: {
  pending: Proposal[];
  stats: { stat: VariantStat; templates: string; verdict: string }[];
  manuals: ManualVersion[];
  fmt: (d: Date) => string;
}) {
  const kind = { apertura_nueva: 'Apertura nueva', promover_apertura: 'Promover apertura', manual: 'Cambio de manual' } as const;
  return (
    <div class="page">
      <div class="card">
        <h2>Propuestas pendientes</h2>
        {p.pending.length === 0 ? <div>No hay propuestas pendientes.</div> : null}
        {p.pending.map((x) => (
          <div class="card">
            <strong>{kind[x.kind] ?? x.kind}:</strong> {x.summary}
            <div><em>Evidencia:</em></div><pre>{x.evidence}</pre>
            <div><em>Contenido propuesto:</em></div><pre>{x.proposedContent}</pre>
            <form method="post" action={`/proposals/${x.id}/approve`} style="display:inline">
              <button type="submit">Aprobar</button>
            </form>{' '}
            <form method="post" action={`/proposals/${x.id}/reject`} style="display:inline">
              <button class="no" type="submit">Rechazar</button>
            </form>
          </div>
        ))}
      </div>
      <div class="card">
        <h2>Aperturas (A/B)</h2>
        <table>
          <thead><tr><th>Variante</th><th>Estado</th><th>Contactos</th><th>Respuestas</th><th>Avanzaron</th><th>Veredicto</th></tr></thead>
          <tbody>
            {p.stats.map((s) => (
              <tr>
                <td>#{s.stat.variantId}<pre>{s.templates}</pre></td>
                <td>{s.stat.status}</td>
                <td>{s.stat.contacted}</td>
                <td>{s.stat.replied}</td>
                <td>{s.stat.advanced}</td>
                <td>{s.verdict}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="card">
        <h2>Historial del manual de ventas</h2>
        {p.manuals.map((m) => (
          <details>
            <summary>{p.fmt(m.createdAt)} · {m.source}{m.active ? ' · activa' : ''}</summary>
            <pre>{m.content}</pre>
          </details>
        ))}
      </div>
    </div>
  );
}

export function SystemView(p: {
  waState: string; qrDataUrl?: string; events: EventRow[]; meetings: Meeting[]; names: Map<number, string>; fmt: (d: Date) => string;
}) {
  return (
    <div class="page">
      <div class="card">
        <h2>WhatsApp</h2>
        <div>Estado: <strong>{p.waState}</strong></div>
        {p.qrDataUrl ? (
          <div>
            <p>Escaneá este QR desde WhatsApp en tu celular (Dispositivos vinculados).</p>
            <img src={p.qrDataUrl} alt="QR de WhatsApp" width="280" height="280" />
          </div>
        ) : null}
      </div>
      <div class="card">
        <h2>Reuniones próximas</h2>
        {p.meetings.length === 0 ? <div>No hay reuniones próximas.</div> : null}
        {p.meetings.map((m) => (
          <div>{p.fmt(m.startsAt)} · <a href={`/p/${m.prospectId}`}>{p.names.get(m.prospectId) ?? `#${m.prospectId}`}</a>
            {m.meetUrl ? <> · <a href={m.meetUrl}>Meet</a></> : null}</div>
        ))}
      </div>
      <div class="card">
        <h2>Últimos eventos</h2>
        <table>
          <tbody>
            {p.events.map((e) => (
              <tr><td>{p.fmt(e.createdAt)}</td><td>{e.type}</td><td><small>{JSON.stringify(e.payload)}</small></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
