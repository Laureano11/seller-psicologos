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
@view-transition{navigation:auto}
:root{
  --porcelana:#EEF1F5;--marino:#10213D;--cobalto:#2E5BFF;
  --tinta:var(--marino);--suave:rgb(16 33 61/.62);--linea:rgb(16 33 61/.1);
  --panel:rgb(255 255 255/.72);--cobalto-velo:rgb(46 91 255/.08);
  --r-panel:18px;--r-item:10px;--ease:cubic-bezier(.2,.7,.2,1);
  color-scheme:light;
}
*{box-sizing:border-box}
html{background:var(--porcelana)}
body{margin:0;font:15px/1.5 ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Roboto,sans-serif;color:var(--tinta);
  background:radial-gradient(1200px 600px at 100% -10%,rgb(46 91 255/.07),transparent 60%),var(--porcelana);
  min-height:100vh;display:grid;grid-template-columns:232px 1fr;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:var(--cobalto);text-decoration:none;transition:opacity .2s var(--ease)}
a:hover{opacity:.75}
:focus-visible{outline:2px solid var(--cobalto);outline-offset:2px;border-radius:6px}
h1,h2,h3,h4{margin:0 0 10px;font-weight:600;letter-spacing:-.01em;line-height:1.25}
h2{font-size:24px}h3{font-size:17px}h4{font-size:13px;color:var(--suave);font-weight:500;margin:14px 0 4px}
small{color:var(--suave)}

/* Barra lateral */
.rail{position:sticky;top:0;height:100vh;background:var(--marino);color:var(--porcelana);padding:28px 18px;display:flex;flex-direction:column;gap:28px;view-transition-name:rail}
.brand{font-weight:600;letter-spacing:.02em;font-size:15px;opacity:.9}
.signal{display:flex;align-items:center;gap:14px;color:var(--porcelana)}
.signal:hover{opacity:1}
.ring{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;font-size:20px;font-weight:300;
  border:1.5px solid rgb(238 241 245/.25);transition:border-color .4s var(--ease),box-shadow .4s var(--ease)}
.signal.on .ring{border-color:var(--cobalto);box-shadow:0 0 0 6px rgb(46 91 255/.18);animation:respira 3.2s var(--ease) infinite}
.signal span{font-size:13px;line-height:1.3;opacity:.8}
@keyframes respira{50%{box-shadow:0 0 0 12px rgb(46 91 255/.05)}}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{color:var(--porcelana);opacity:.62;padding:9px 12px;border-radius:var(--r-item);transition:opacity .25s var(--ease),background-color .25s var(--ease)}
.nav a:hover{opacity:1;background:rgb(238 241 245/.06)}
.nav a.on{opacity:1;background:rgb(238 241 245/.1);box-shadow:inset 2px 0 0 var(--cobalto)}
.wa{margin-top:auto;font-size:13px;opacity:.75;display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:rgb(238 241 245/.35)}
.wa.ok .dot{background:var(--cobalto);box-shadow:0 0 0 3px rgb(46 91 255/.25)}

/* Área principal */
main{min-width:0;padding:28px 32px 40px;view-transition-name:main;animation:entra .5s var(--ease) both}
@keyframes entra{from{opacity:0;transform:translateY(6px)}}
::view-transition-old(main){animation:.18s var(--ease) both sale}
::view-transition-new(main){animation:.32s var(--ease) both entra}
@keyframes sale{to{opacity:0}}
.banner{margin:0 0 10px;padding:11px 16px;border-radius:var(--r-item);background:var(--panel);border:1px solid var(--linea);font-size:14px;backdrop-filter:blur(8px)}
.notices{list-style:none;margin:0 0 18px;padding:4px 16px;border-radius:var(--r-item);background:var(--panel);border:1px solid var(--linea);backdrop-filter:blur(8px)}
.notices .banner{margin:0;padding:7px 0 7px 16px;border:0;border-radius:0;background:none;backdrop-filter:none;font-size:13.5px;color:var(--suave);position:relative}
.notices .banner+.banner{border-top:1px solid var(--linea)}
.notices .banner::before{content:'';position:absolute;left:0;top:50%;width:6px;height:6px;margin-top:-3px;border-radius:50%;border:1.5px solid var(--marino);opacity:.5}
.banner.error{border-color:var(--cobalto);background:var(--cobalto-velo)}

.metrics{display:flex;flex-wrap:wrap;margin:6px 0 26px;border-top:1px solid var(--linea);border-bottom:1px solid var(--linea)}
.metric{flex:1 1 120px;padding:16px 18px;border-left:1px solid var(--linea)}
.metric:first-child{border-left:0;padding-left:2px}
.metric b{display:block;font-size:34px;font-weight:300;letter-spacing:-.03em;line-height:1.1}
.metric span{font-size:13px;color:var(--suave)}
.metric.hot b{color:var(--cobalto)}

.cols{display:flex;gap:20px;align-items:flex-start}
.list{flex:0 0 330px;max-width:100%;background:var(--panel);border:1px solid var(--linea);border-radius:var(--r-panel);padding:6px;backdrop-filter:blur(10px);max-height:calc(100vh - 220px);overflow:auto}
.detail{flex:1;min-width:0}
.card{background:var(--panel);border:1px solid var(--linea);border-radius:var(--r-panel);padding:20px 22px;margin-bottom:16px;backdrop-filter:blur(10px)}
.card .card{background:transparent;border-radius:var(--r-item);padding:16px}
.item{display:block;padding:11px 14px;border-radius:var(--r-item);color:inherit;transition:background-color .25s var(--ease),transform .25s var(--ease)}
.item:hover{opacity:1;background:var(--cobalto-velo)}
.item.sel{background:var(--marino);color:var(--porcelana)}
.item.sel small{color:rgb(238 241 245/.7)}
.item small{display:block;font-size:13px}
.pin{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--cobalto);margin-right:8px;vertical-align:middle;box-shadow:0 0 0 3px rgb(46 91 255/.2)}
.tag{display:inline-block;font-size:12px;border:1px solid var(--linea);border-radius:99px;padding:1px 9px;margin-left:4px}

.chat{display:flex;flex-direction:column;gap:8px}
.bubble{max-width:78%;padding:9px 14px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.bubble small{display:block;font-size:12px;margin-bottom:2px}
.bubble.prospect{background:#fff;border:1px solid var(--linea);align-self:flex-start;border-bottom-left-radius:5px}
.bubble.agent{background:var(--cobalto-velo);border:1px solid rgb(46 91 255/.22);align-self:flex-end;border-bottom-right-radius:5px}
.bubble.lauri{background:var(--marino);color:var(--porcelana);align-self:flex-end;border-bottom-right-radius:5px}
.bubble.lauri small{color:rgb(238 241 245/.7)}

textarea{width:100%;min-height:96px;font:inherit;color:inherit;padding:12px 14px;border:1px solid var(--linea);border-radius:var(--r-item);background:#fff;resize:vertical;transition:border-color .2s var(--ease),box-shadow .2s var(--ease);margin-bottom:10px}
textarea:focus{outline:0;border-color:var(--cobalto);box-shadow:0 0 0 4px rgb(46 91 255/.12)}
button{font:inherit;font-weight:500;padding:10px 20px;border:1px solid var(--cobalto);border-radius:99px;background:var(--cobalto);color:#fff;cursor:pointer;
  transition:transform .15s var(--ease),box-shadow .25s var(--ease),background-color .25s var(--ease)}
button:hover{box-shadow:0 6px 18px -6px rgb(46 91 255/.6)}
button:active{transform:scale(.97)}
button.no{background:transparent;color:var(--marino);border-color:var(--linea)}
button.no:hover{box-shadow:none;border-color:var(--marino)}

table{border-collapse:collapse;width:100%;font-size:14px}
th{font-weight:500;color:var(--suave);font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--linea);vertical-align:top}
tbody tr{transition:background-color .2s var(--ease)}
tbody tr:hover{background:var(--cobalto-velo)}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgb(16 33 61/.04);padding:10px 12px;border-radius:var(--r-item);margin:8px 0;font:13px/1.5 inherit}
details summary{cursor:pointer;padding:6px 0}
.page{padding:0}
img{border-radius:var(--r-item)}

@media(max-width:860px){
  body{grid-template-columns:1fr}
  .rail{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:14px;padding:14px 16px}
  .brand{display:none}.ring{width:40px;height:40px;font-size:16px}
  .nav{flex-direction:row;flex-wrap:wrap}.wa{margin:0}
  main{padding:18px 16px 32px}
  .cols{flex-direction:column}.list{flex:none;width:100%;max-height:none}.bubble{max-width:92%}
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
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <aside class="rail">
          <div class="brand">Hub de ventas</div>
          <a href="/" class={n > 0 ? 'signal on' : 'signal'}>
            <div class="ring">{n}</div>
            <span>{n === 1 ? 'conversación te necesita' : n > 1 ? 'conversaciones te necesitan' : 'Nada pendiente para vos'}</span>
          </a>
          <nav class="nav">
            {link('/', 'Prospectos')}
            {link('/pipeline', 'Pipeline')}
            {link('/mejoras', 'Mejoras')}
            {link('/sistema', 'Sistema')}
          </nav>
          {p.wa !== undefined ? <div class={p.wa === 'conectado' ? 'wa ok' : 'wa'}><span class="dot"></span>WhatsApp {p.wa}</div> : null}
        </aside>
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

function Metric(p: { n: string | number; label: string; hot?: boolean }) {
  return <div class={p.hot ? 'metric hot' : 'metric'}><b>{p.n}</b><span>{p.label}</span></div>;
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
      <Metric n={m.teNecesitan} label="Te necesitan" hot={m.teNecesitan > 0} />
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
