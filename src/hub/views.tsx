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
@font-face{font-family:Geist;src:url(/fonts/Geist-Regular.woff2) format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:Geist;src:url(/fonts/Geist-Medium.woff2) format('woff2');font-weight:500;font-display:swap}
@font-face{font-family:'Geist Mono';src:url(/fonts/GeistMono-Regular.woff2) format('woff2');font-weight:400;font-display:swap}
@view-transition{navigation:auto}
:root{
  --canvas:#101010;--lift:#1d1a18;--btn:#1f1d1c;--stroke:#3d3a39;--graphite:#4d4947;
  --granite:#8a8380;--stone:#b8b3b0;--bone:#eeeeee;--chalk:#fafafa;--ink:#101010;
  --orange:#ee6018;--green:#a0ca92;
  --sans:Geist,Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --mono:'Geist Mono','JetBrains Mono','IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --r-sm:3px;--r-card:10px;--r-panel:20px;--ease:cubic-bezier(.4,0,.2,1);
  color-scheme:dark;
}
*{box-sizing:border-box}
html{background:var(--canvas)}
body{margin:0;background:var(--canvas);color:var(--bone);font:400 16px/1.5 var(--sans);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:var(--bone);text-decoration:underline;text-decoration-color:var(--stroke);text-underline-offset:3px;transition:color .15s var(--ease),text-decoration-color .15s var(--ease)}
a:hover{color:var(--chalk);text-decoration-color:var(--chalk)}
:focus-visible{outline:1px solid var(--orange);outline-offset:3px}
h1,h2,h3{font-weight:400;margin:0 0 16px}
h2{font-size:36px;line-height:1.1;letter-spacing:-1.12px}
h3{font-size:16px;line-height:1.5;letter-spacing:-.02em;margin-bottom:12px}
h4,th,.label{font:400 12px/1 var(--mono);letter-spacing:-.24px;text-transform:uppercase;color:var(--stone)}
h4{margin:24px 0 8px}
small{color:var(--granite);font-size:14px}
.mono{font-family:var(--mono);font-size:13px}

/* Barra superior */
.top{position:sticky;top:0;z-index:5;background:rgb(16 16 16/.96);border-bottom:1px solid var(--lift);view-transition-name:top}
.top-in{max-width:1200px;margin:0 auto;height:64px;padding:0 24px;display:flex;align-items:center;gap:32px}
.mark{font:400 12px/1 var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--bone);text-decoration:none;display:flex;align-items:center;gap:10px}
.nav{display:flex;gap:4px;flex:1}
.nav a{font-size:14px;text-transform:uppercase;text-decoration:none;color:var(--granite);padding:8px 12px;border-radius:var(--r-sm);transition:color .15s var(--ease),background-color .15s var(--ease)}
.nav a:hover{color:var(--bone)}
.nav a.on{color:var(--bone);background:var(--lift)}
.wa{font:400 12px/1 var(--mono);text-transform:uppercase;color:var(--granite);display:flex;align-items:center;gap:8px}
.pulse{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--graphite);flex:none}
.pulse.live{background:var(--orange)}
.pulse.ok{background:var(--green)}
.need{font-size:14px;text-decoration:none;padding:8px 14px;border-radius:var(--r-sm);background:var(--lift);color:var(--granite);display:flex;align-items:center;gap:8px;transition:background-color .15s var(--ease),color .15s var(--ease)}
.need.on{background:var(--chalk);color:var(--ink)}
.need.on:hover{color:var(--ink);background:var(--bone)}

/* Lienzo */
main{max-width:1200px;margin:0 auto;padding:40px 24px 96px;view-transition-name:main}
::view-transition-old(main),::view-transition-new(main){animation-duration:.2s;animation-timing-function:var(--ease)}
.notices{list-style:none;margin:0 0 40px;padding:0;border-top:1px solid var(--lift)}
.banner{display:flex;gap:12px;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--lift);font-size:14px;color:var(--granite)}
.banner::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--orange);flex:none;transform:translateY(-1px)}
.banner.error{color:var(--bone);margin:0 0 16px;border-top:1px solid var(--lift)}

.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));border:1px solid var(--lift);border-radius:var(--r-card);margin:0 0 56px;overflow:hidden}
.metric{padding:20px;border-left:1px solid var(--lift);display:flex;flex-direction:column-reverse;gap:12px}
.metric:first-child{border-left:0}
.metric b{font:400 36px/1.1 var(--sans);letter-spacing:-1.12px;color:var(--bone)}
.metric span{font:400 12px/1 var(--mono);letter-spacing:-.24px;text-transform:uppercase;color:var(--stone)}
.metric.good b{color:var(--green)}
.metric.hot b{color:var(--orange)}

.cols{display:grid;grid-template-columns:320px 1fr;gap:24px;align-items:start}
.list{border:1px solid var(--lift);border-radius:var(--r-card);overflow:hidden;position:sticky;top:88px;max-height:calc(100vh - 112px);overflow-y:auto}
.item{display:block;padding:16px 20px;border-bottom:1px solid var(--lift);text-decoration:none;color:var(--bone);transition:background-color .15s var(--ease)}
.item:last-child{border-bottom:0}
.item:hover{background:var(--lift);color:var(--bone)}
.item.sel{background:var(--bone);color:var(--ink)}
.item.sel small{color:var(--graphite)}
.item strong{font-weight:400;letter-spacing:-.01em}
.item small{display:block;font:400 12px/1.4 var(--mono);text-transform:uppercase;letter-spacing:-.24px;margin-top:4px}
.pin{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--orange);margin-right:10px;vertical-align:middle}

/* La tarjeta clara: el trabajo sobre la mesa */
.detail{background:var(--bone);color:var(--ink);border-radius:var(--r-panel);padding:8px 32px;min-width:0;animation:aterriza .2s var(--ease) both}
@keyframes aterriza{from{opacity:0;transform:translateY(4px)}}
.detail .card{padding:24px 0;border:0;border-bottom:1px solid #d6d3d1;border-radius:0;margin:0}
.detail .card:last-child{border-bottom:0}
.detail h2{color:var(--ink)}
.detail h3{color:var(--ink)}
.detail small{color:var(--graphite)}
.detail a{color:var(--ink);text-decoration-color:var(--stone)}
.detail pre{background:#e2e0de;color:var(--ink)}
.detail .card.ask{border-left:2px solid var(--orange);padding-left:20px}
.card{border:1px solid var(--lift);border-radius:var(--r-card);padding:24px;margin-bottom:24px}
.card .card{background:var(--bone);color:var(--ink);border:0}
.card .card pre{background:#e2e0de;color:var(--ink)}
.tag{display:inline-block;font:400 12px/1 var(--mono);text-transform:uppercase;padding:4px 6px;border:1px solid var(--stroke);border-radius:var(--r-sm);margin-left:6px}

.chat{display:flex;flex-direction:column;gap:12px}
.bubble{max-width:78%;padding:12px 16px;border-radius:var(--r-card);white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.5}
.bubble small{display:block;font:400 12px/1 var(--mono);text-transform:uppercase;letter-spacing:-.24px;margin-bottom:8px}
.bubble.prospect{background:var(--chalk);border:1px solid #d6d3d1;align-self:flex-start}
.bubble.prospect small{color:var(--granite)}
.bubble.agent{background:var(--ink);color:var(--bone);align-self:flex-end}
.bubble.agent small{color:var(--granite)}
.bubble.lauri{background:var(--lift);color:var(--bone);align-self:flex-end;border:1px solid var(--orange)}
.bubble.lauri small{color:var(--orange)}

textarea{width:100%;min-height:104px;font:inherit;color:var(--ink);background:var(--chalk);border:1px solid #d6d3d1;border-radius:var(--r-sm);padding:12px 14px;resize:vertical;margin-bottom:12px;transition:border-color .15s var(--ease)}
textarea:focus{outline:0;border-color:var(--ink)}
button{font:400 14px/1 var(--sans);height:36px;padding:0 14px;border:1px solid transparent;border-radius:var(--r-sm);background:var(--btn);color:var(--bone);cursor:pointer;transition:background-color .15s var(--ease),color .15s var(--ease),border-color .15s var(--ease)}
button:hover{background:var(--graphite)}
button:active{background:var(--stroke)}
.detail button,.card .card button{background:var(--ink);color:var(--bone)}
.detail button:hover,.card .card button:hover{background:var(--graphite)}
button.no,.card .card button.no{background:transparent;color:inherit;border-color:var(--stroke)}
button.no:hover,.card .card button.no:hover{border-color:currentColor;background:transparent}

table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.43}
th,td{text-align:left;padding:12px 12px 12px 0;border-bottom:1px solid var(--lift);vertical-align:top}
tbody tr{transition:background-color .15s var(--ease)}
tbody tr:hover{background:var(--lift)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--lift);padding:12px 14px;border-radius:var(--r-sm);margin:8px 0;font:400 13px/1.5 var(--mono)}
details{border-top:1px solid var(--lift)}
details summary{cursor:pointer;padding:12px 0;font-size:14px;color:var(--stone)}
img{border-radius:var(--r-card);background:var(--chalk);padding:12px}
hr{border:0;border-top:1px solid var(--lift);margin:16px 0}

@media(max-width:860px){
  .top-in{height:auto;flex-wrap:wrap;gap:12px 20px;padding:14px 16px}
  .nav{order:3;flex-basis:100%;overflow-x:auto}
  main{padding:24px 16px 64px}
  h2{font-size:28px;letter-spacing:-.8px}
  .cols{grid-template-columns:1fr}
  .list{position:static;max-height:none}
  .detail{padding:4px 20px}
  .bubble{max-width:92%}
}
@media(prefers-reduced-motion:reduce){*,::before,::after{animation:none!important;transition:none!important}::view-transition-group(*){animation:none!important}}
`;

export function Layout(p: { title?: string; refresh?: boolean; banners?: string[]; error?: string; active?: string; attention?: number; wa?: string; children?: Child }) {
  const n = p.attention ?? 0;
  const link = (href: string, label: string) => <a href={href} class={p.active === href ? 'on' : undefined} aria-current={p.active === href ? 'page' : undefined}>{label}</a>;
  return (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {p.refresh ? <meta http-equiv="refresh" content="30" /> : null}
        <title>{p.title ?? 'Hub de ventas'}</title>
        <link rel="preload" href="/fonts/Geist-Regular.woff2" as="font" type="font/woff2" crossorigin="" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header class="top">
          <div class="top-in">
            <a class="mark" href="/"><span class={n > 0 ? 'pulse live' : 'pulse'}></span>Hub de ventas</a>
            <nav class="nav">
              {link('/', 'Prospectos')}
              {link('/pipeline', 'Pipeline')}
              {link('/mejoras', 'Mejoras')}
              {link('/sistema', 'Sistema')}
            </nav>
            {p.wa !== undefined ? <div class="wa"><span class={p.wa === 'conectado' ? 'pulse ok' : 'pulse'}></span>WhatsApp {p.wa}</div> : null}
            <a href="/" class={n > 0 ? 'need on' : 'need'}>
              {n === 0 ? 'Nada pendiente' : n === 1 ? '1 conversación te necesita' : `${n} conversaciones te necesitan`}
            </a>
          </div>
        </header>
        <main>
          {p.error ? <div class="banner error" role="alert">{p.error}</div> : null}
          {(p.banners ?? []).length > 0 ? <ul class="notices">{(p.banners ?? []).map((b) => <li class="banner">{b}</li>)}</ul> : null}
          {p.children}
        </main>
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

function Metric(p: { n: string | number; label: string; tone?: 'good' | 'hot' }) {
  return <div class={p.tone ? `metric ${p.tone}` : 'metric'}><b>{p.n}</b><span>{p.label}</span></div>;
}

export function MetricsBar({ m }: { m: Metrics }) {
  const pct = m.contactados > 0 ? Math.round((m.respondieron / m.contactados) * 100) : 0;
  return (
    <div class="metrics">
      <Metric n={m.encontrados} label="Encontrados" />
      <Metric n={m.contactados} label="Contactados" />
      <Metric n={`${m.respondieron} (${pct}%)`} label="Respondieron" />
      <Metric n={m.listos} label="Listos para cerrar" tone={m.listos > 0 ? 'good' : undefined} />
      <Metric n={m.rechazados} label="Rechazados" />
      <Metric n={m.sinRespuesta} label="Sin respuesta" />
      <Metric n={m.teNecesitan} label="Te necesitan" tone={m.teNecesitan > 0 ? 'hot' : undefined} />
    </div>
  );
}

export function ProspectList({ prospects, selectedId }: { prospects: Prospect[]; selectedId?: number }) {
  return (
    <div class="list">
      {prospects.length === 0 ? <div class="item">Todavía no hay prospectos.</div> : null}
      {prospects.map((p) => (
        <a class={p.id === selectedId ? 'item sel' : 'item'} href={`/p/${p.id}`}>
          {p.needsAttention ? <span class="pin" aria-label="Te necesita"></span> : null}<strong>{p.name}</strong>
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
        {x.needsAttention ? <div><span class="pin"></span>{x.needsAttention}</div> : null}
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
        <div class="card ask">
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
