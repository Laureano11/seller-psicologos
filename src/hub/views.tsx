import type { Child } from 'hono/jsx';
import { raw } from 'hono/html';
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

// Estado = borde + tinte + punto. Nunca rojo/verde/amarillo: signal (azul) vs bone (blanco) vs muted, sólido vs hueco
export type Tone = 'live' | 'positive' | 'attention' | 'neutral' | 'quiet' | 'void';
const STATUS_TONE: Record<Status, Tone> = {
  encontrado: 'quiet', contactado: 'neutral', conversando: 'neutral', interesado: 'attention',
  reunion_agendada: 'positive', listo_para_cerrar: 'live', rechazado: 'void', sin_respuesta: 'quiet', baja: 'void', descartado: 'void',
};

const CSS = `
@font-face{font-family:Inter;src:url(/fonts/Inter-Variable.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:Sora;src:url(/fonts/Sora-Variable.woff2) format('woff2');font-weight:100 800;font-display:swap}
@font-face{font-family:'JetBrains Mono';src:url(/fonts/JetBrainsMono-Variable.woff2) format('woff2');font-weight:100 800;font-display:swap}
@view-transition{navigation:auto}
:root{
  color-scheme:dark;
  --bg:oklch(.145 .012 262);--fg:oklch(.965 .004 262);--surface:oklch(.172 .012 262);--popover:oklch(.19 .013 262);
  --muted:oklch(.69 .012 262);--border:oklch(1 0 0/8%);--input:oklch(1 0 0/12%);
  --signal:oklch(.72 .15 250);--chart2:oklch(.5 .014 262);
  --sidebar:oklch(.13 .012 262);--sidebar-accent:oklch(.2 .012 262);--sidebar-border:oklch(1 0 0/7%);
  --sans:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  --heading:Sora,var(--sans);
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --r-md:10px;--r-lg:12px;--r-xl:17px;--r-2xl:22px;
  --ease:cubic-bezier(.32,.72,0,1);
  --shadow-bone:0 1px 0 0 oklch(1 0 0/60%) inset,0 10px 28px -14px oklch(.965 .004 262/45%);
  --shadow-lift:0 1px 0 0 oklch(1 0 0/5%) inset,0 24px 48px -24px oklch(0 0 0/85%);
}
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:oklch(1 0 0/14%) transparent}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--fg);font:400 13px/1.5 var(--sans);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
::selection{background:oklch(.72 .15 250/35%);color:var(--fg)}
a{color:var(--fg);text-decoration:underline;text-decoration-color:oklch(1 0 0/20%);text-underline-offset:3px;transition:text-decoration-color .2s var(--ease)}
a:hover{text-decoration-color:var(--fg)}
:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
h1,h2,h3{font-family:var(--heading);font-weight:600;letter-spacing:-.02em;margin:0}
h2{font-size:15px;line-height:1.3;margin-bottom:16px}
h3{font-size:15px;line-height:1.3;margin-bottom:12px}
h4,th,.label{font:500 10px/1.2 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
h4{margin:20px 0 8px}
small{color:var(--muted);font-size:12px}
p{margin:0 0 12px}
.mono{font-family:var(--mono);font-size:11px}

/* Marco: sidebar + topbar */
.sidebar{position:fixed;inset:0 auto 0 0;z-index:30;width:248px;background:var(--sidebar);border-right:1px solid var(--sidebar-border);display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:12px;padding:20px 20px 24px;text-decoration:none;color:var(--fg)}
.brand svg{width:32px;height:32px;flex:none}
.brand b{display:block;font:600 15px/1.2 var(--heading);letter-spacing:-.02em}
.brand > span > span{display:block;font:400 10px/1.4 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.nav{padding:0 12px}
.nav p{padding:0 12px 8px;margin:0;font:400 10px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.nav ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.nav a{position:relative;display:flex;align-items:center;gap:12px;height:36px;padding:0 12px;border:1px solid transparent;border-radius:var(--r-lg);font-size:13px;font-weight:500;text-decoration:none;color:var(--muted);transition:color .2s var(--ease),background-color .2s var(--ease)}
.nav a:hover{color:var(--fg);background:oklch(1 0 0/.03)}
.nav a svg{width:16px;height:16px;flex:none}
.nav a.on{color:var(--fg);background:var(--sidebar-accent);border-color:oklch(1 0 0/.07);box-shadow:0 1px 0 0 oklch(1 0 0/5%) inset}
.nav a.on::before{content:'';position:absolute;left:-1px;top:50%;width:2px;height:16px;transform:translateY(-50%);border-radius:2px;background:var(--signal);box-shadow:0 0 12px var(--signal)}
.badge{margin-left:auto;min-width:20px;height:20px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center;border:1px solid oklch(.72 .15 250/35%);background:oklch(.72 .15 250/10%);border-radius:6px;font:400 10px/1 var(--mono);color:var(--fg)}
.side-foot{margin-top:auto;padding:12px}
.status-card{display:block;border:1px solid var(--sidebar-border);background:oklch(1 0 0/.02);border-radius:var(--r-xl);padding:16px;text-decoration:none;color:var(--fg);transition:border-color .2s var(--ease)}
.status-card:hover{border-color:oklch(1 0 0/15%)}
.status-card .row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;font-weight:500}
.status-card .row span:first-child{display:flex;align-items:center;gap:8px}
.status-card .row .mono{color:var(--muted);font-weight:400}
.meter{display:flex;gap:4px;margin-top:12px}
.meter i{height:4px;flex:1;border-radius:9px;background:oklch(1 0 0/12%)}
.meter i.on{background:var(--signal)}
.status-card small{display:block;margin-top:12px}

.page-wrap{padding-left:248px;min-height:100vh;display:flex;flex-direction:column}
.top{position:sticky;top:0;z-index:20;height:56px;display:flex;align-items:center;gap:12px;padding:0 40px;border-bottom:1px solid var(--border);background:oklch(.145 .012 262/70%);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);view-transition-name:top}
.crumb{display:flex;align-items:center;gap:8px;font:400 11px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.crumb i{font-style:normal;color:oklch(1 0 0/20%)}
.crumb b{font-weight:400;color:oklch(.965 .004 262/85%)}
.top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.chip{height:32px;display:inline-flex;align-items:center;gap:8px;padding:0 12px;border:1px solid var(--border);background:oklch(1 0 0/.02);border-radius:var(--r-lg);font:400 11px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.btn,button{font:500 13px/1 var(--sans);height:32px;padding:0 14px;display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:var(--r-lg);background:oklch(1 0 0/.03);color:var(--fg);text-decoration:none;cursor:pointer;transition:background-color .2s var(--ease),border-color .2s var(--ease),transform .15s var(--ease)}
.btn:hover,button:hover{background:oklch(1 0 0/.06);border-color:oklch(1 0 0/18%)}
.btn:active,button:active{transform:scale(.97)}
.btn.primary,button{background:var(--fg);color:var(--bg);border-color:transparent;box-shadow:var(--shadow-bone)}
.btn.primary:hover,button:hover{background:oklch(.9 .004 262);border-color:transparent}
button.no{background:transparent;color:var(--fg);border-color:var(--input);box-shadow:none}
button.no:hover{background:oklch(1 0 0/.04);border-color:oklch(1 0 0/20%)}

/* Lienzo con grilla y resplandor */
main{position:relative;flex:1;view-transition-name:main}
main::before,main::after{content:'';position:absolute;inset:0 0 auto;height:460px;pointer-events:none}
main::before{background-image:linear-gradient(to right,oklch(1 0 0/3.5%) 1px,transparent 1px),linear-gradient(to bottom,oklch(1 0 0/3.5%) 1px,transparent 1px);background-size:56px 56px;-webkit-mask-image:linear-gradient(to bottom,#000,#000 40%,transparent);mask-image:linear-gradient(to bottom,#000,#000 40%,transparent);opacity:.6}
main::after{background:radial-gradient(55% 60% at 50% 0%,oklch(.72 .15 250/.09),transparent 70%)}
.content{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:36px 40px 80px;animation:entra .5s var(--ease) both}
@keyframes entra{from{opacity:0;transform:translateY(8px)}}
::view-transition-old(main),::view-transition-new(main){animation-duration:.2s}

.ph{padding-bottom:32px}
.eyebrow{display:flex;align-items:center;gap:8px;margin:0 0 12px;font:400 11px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.eyebrow::before{content:'';width:6px;height:6px;border-radius:2px;background:var(--signal);box-shadow:0 0 10px var(--signal)}
.ph h1{font-size:34px;line-height:1.1;text-wrap:balance}
.ph p{margin:10px 0 0;max-width:42rem;font-size:15px;line-height:1.65;color:var(--muted)}

/* Tarjeta de atención: la única superficie teñida de azul */
.attn{border:1px solid oklch(.72 .15 250/25%);background:oklch(.72 .15 250/.035);border-radius:var(--r-2xl);margin:0 0 24px;overflow:hidden}
.attn-h{display:flex;align-items:center;gap:10px;padding:14px 20px;font-size:13px;font-weight:500;border-bottom:1px solid oklch(.72 .15 250/15%)}
.attn-h .mono{margin-left:auto;color:var(--muted);font-weight:400}
.notices{list-style:none;margin:0;padding:0}
.banner{display:flex;align-items:center;gap:14px;padding:12px 20px;border-top:1px solid oklch(.72 .15 250/10%);font-size:13px;color:oklch(.965 .004 262/90%)}
.banner:first-child{border-top:0}
.banner::before{content:'AVISO';flex:none;width:72px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:1px solid oklch(.72 .15 250/40%);border-radius:6px;font:500 10px/1 var(--mono);letter-spacing:.14em;color:var(--fg)}
.banner.error{margin:0 0 24px;border:1px solid oklch(1 0 0/25%);background:oklch(1 0 0/.04);border-radius:var(--r-xl)}
.banner.error::before{content:'ERROR';border-color:oklch(1 0 0/30%)}

/* Puntos y pills */
.dot{position:relative;display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--muted);flex:none}
.dot.signal{background:var(--signal)}
.dot.bone{background:var(--fg)}
.dot.hollow{background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
.dot.bone.hollow{color:var(--fg)}.dot.muted.hollow{color:var(--muted)}
.dot.pulse::after{content:'';position:absolute;inset:0;border-radius:50%;background:var(--signal);animation:ring 2.4s cubic-bezier(.2,.6,.3,1) infinite}
@keyframes ring{0%{transform:scale(1);opacity:.6}80%,100%{transform:scale(2.8);opacity:0}}
.pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:1px solid var(--border);border-radius:999px;font-size:11px;font-weight:500;white-space:nowrap;flex:none;color:oklch(.965 .004 262/80%);background:oklch(1 0 0/.03)}
.pill.live,.pill.positive{border-color:oklch(.72 .15 250/30%);background:oklch(.72 .15 250/8%);color:var(--fg)}
.pill.attention{border-color:oklch(1 0 0/25%);background:oklch(1 0 0/.04);color:var(--fg)}
.pill.quiet,.pill.void{background:transparent;color:var(--muted)}
.pill.void{text-decoration:line-through;text-decoration-color:oklch(.69 .012 262/50%)}

/* KPIs */
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin:0 0 24px}
.metric{position:relative;overflow:hidden;padding:20px;display:flex;flex-direction:column-reverse;justify-content:flex-end;gap:20px;background:var(--surface) linear-gradient(180deg,oklch(1 0 0/2.5%),transparent 120px);border:1px solid var(--border);border-radius:var(--r-xl);transition:border-color .3s var(--ease),translate .3s var(--ease)}
.metric::before{content:'';position:absolute;left:24px;right:24px;top:0;height:1px;background:linear-gradient(to right,transparent,oklch(1 0 0/20%),transparent);opacity:0;transition:opacity .5s}
.metric:hover{translate:0 -2px;border-color:oklch(1 0 0/15%)}
.metric:hover::before{opacity:1}
.metric b{font:600 34px/1 var(--sans);letter-spacing:-.02em;color:var(--fg)}
.metric span{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.metric.good span::after,.metric.hot span::after{content:'';margin-left:auto;width:6px;height:6px;border-radius:50%;background:var(--signal);box-shadow:0 0 8px var(--signal)}
.metric.hot{border-color:oklch(.72 .15 250/30%);background-color:oklch(.72 .15 250/.035)}

/* Paneles */
.cols{display:grid;grid-template-columns:minmax(0,360px) minmax(0,1fr);gap:20px;align-items:start}
.card,.list,.detail{background:var(--surface) linear-gradient(180deg,oklch(1 0 0/2.5%),transparent 120px);border:1px solid var(--border);border-radius:var(--r-xl)}
.card{padding:20px 24px;margin-bottom:20px}
.card .card{background:oklch(1 0 0/.02);padding:16px 18px;margin:12px 0 0;border-radius:var(--r-lg)}
.list{padding:8px;position:sticky;top:76px;max-height:calc(100vh - 96px);overflow-y:auto}
.list-h{display:flex;align-items:center;justify-content:space-between;padding:10px 12px 12px;font:400 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.item{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid transparent;border-radius:var(--r-lg);text-decoration:none;color:var(--fg);transition:background-color .2s var(--ease),border-color .2s var(--ease)}
.item:hover{background:oklch(1 0 0/.03);border-color:var(--border)}
.item.sel{background:oklch(1 0 0/.09);border-color:oklch(1 0 0/.07)}
.avatar{position:relative;width:36px;height:36px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);background:oklch(1 0 0/.03);border-radius:var(--r-lg);font:600 14px/1 var(--heading)}
.avatar .dot{position:absolute;right:-3px;bottom:-3px;width:10px;height:10px;border:2px solid var(--surface);box-sizing:content-box}
.item-t{min-width:0;flex:1}
.item strong{display:block;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item small{display:block;font:400 11px/1.4 var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{padding:40px 16px;text-align:center;color:var(--muted)}

.detail{padding:4px 24px;min-width:0}
.detail > .card{background:none;border:0;border-radius:0;border-bottom:1px solid var(--border);padding:20px 0;margin:0}
.detail > .card:last-child{border-bottom:0}
.detail .ask{border:1px solid oklch(.72 .15 250/25%)!important;background:oklch(.72 .15 250/.035)!important;border-radius:var(--r-2xl)!important;padding:20px!important;margin:16px 0!important}
.ask h3{display:flex;align-items:center;gap:10px}
.ask h3::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--signal);box-shadow:0 0 8px var(--signal)}
.d-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.d-head h2{font-size:22px;line-height:1.15;margin:0 0 8px}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1px;margin-top:16px;border:1px solid var(--border);border-radius:var(--r-lg);overflow:hidden;background:var(--border)}
.facts div{background:var(--popover);padding:10px 14px;min-width:0}
.facts dt{font:400 10px/1.2 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.facts dd{margin:0;font-size:13px;overflow-wrap:anywhere}
.need-line{display:flex;align-items:center;gap:10px;margin-top:14px;font-size:13px}
.tag{display:inline-block;font:500 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;padding:5px 7px;border:1px solid var(--border);border-radius:6px;margin-left:6px;color:var(--muted)}

.chat{display:flex;flex-direction:column;gap:10px}
.bubble{max-width:78%;padding:10px 14px;border:1px solid var(--border);border-radius:var(--r-lg);white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6}
.bubble small{display:block;font:400 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;margin-bottom:8px}
.bubble.prospect{background:oklch(1 0 0/.04);align-self:flex-start}
.bubble.agent{background:oklch(1 0 0/.015);align-self:flex-end;color:oklch(.965 .004 262/90%)}
.bubble.lauri{background:oklch(.72 .15 250/.06);border-color:oklch(.72 .15 250/35%);align-self:flex-end}
.bubble.lauri small{color:var(--signal)}

textarea{width:100%;min-height:104px;font:inherit;font-size:13px;color:var(--fg);background:oklch(1 0 0/.02);border:1px solid var(--input);border-radius:var(--r-lg);padding:10px 12px;resize:vertical;margin-bottom:12px;transition:border-color .2s var(--ease),box-shadow .2s var(--ease)}
textarea::placeholder{color:var(--muted)}
textarea:focus{outline:0;border-color:oklch(.72 .15 250/60%);box-shadow:0 0 0 3px oklch(.72 .15 250/20%)}

table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.45}
th{padding:10px 12px 10px 0;border-bottom:1px solid var(--border);text-align:left;font-weight:500}
td{text-align:left;padding:12px 12px 12px 0;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background-color .2s var(--ease)}
tbody tr:hover{background:oklch(1 0 0/.035)}
td.t{font:400 11px/1.6 var(--mono);color:var(--muted);white-space:nowrap}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:oklch(1 0 0/.025);border:1px solid var(--border);padding:10px 12px;border-radius:var(--r-md);margin:8px 0;font:400 12px/1.6 var(--mono);color:oklch(.965 .004 262/90%)}
details{border-top:1px solid var(--border)}
details summary{cursor:pointer;padding:12px 0;font:400 11px/1.4 var(--mono);color:var(--muted)}
details summary:hover{color:var(--fg)}
img{border-radius:var(--r-lg);background:#fff;padding:12px}
hr{border:0;border-top:1px solid var(--border);margin:16px 0}
.actions{display:flex;gap:8px;margin-top:14px}
.rows{list-style:none;margin:0;padding:0}
.rows li{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)}
.rows li:last-child{border-bottom:0}

@media(max-width:1023px){
  .sidebar{position:static;width:auto;border-right:0;border-bottom:1px solid var(--sidebar-border)}
  .brand{padding:16px 16px 12px}
  .nav{padding:0 8px 10px}.nav p,.side-foot{display:none}
  .nav ul{flex-direction:row;overflow-x:auto}
  .nav a{flex:none}
  .page-wrap{padding-left:0;min-height:0}
  .top{padding:0 24px}
  .content{padding:28px 24px 64px}
  .cols{grid-template-columns:1fr}
  .list{position:static;max-height:none}
}
@media(max-width:639px){
  .crumb,.chip{display:none}
  .top{padding:0 16px}
  .content{padding:24px 16px 56px}
  .ph h1{font-size:28px}
  .detail{padding:4px 16px}
  .bubble{max-width:92%}
  .banner{flex-wrap:wrap}
}
@media(prefers-reduced-motion:reduce){*,::before,::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}::view-transition-group(*){animation:none!important}}
`;

const ICONS: Record<string, string> = {
  '/': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  '/pipeline': '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  '/mejoras': '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  '/sistema': '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
};
const NAV = [['/', 'Prospectos'], ['/pipeline', 'Pipeline'], ['/mejoras', 'Mejoras'], ['/sistema', 'Sistema']] as const;

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{raw(d)}</svg>
);

// Tile de vidrio + glifo blanco + punto signal
const BRAND = `<defs><linearGradient id="bm" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="oklch(1 0 0 / .14)"/><stop offset="1" stop-color="oklch(1 0 0 / .03)"/></linearGradient></defs>
<rect x=".75" y=".75" width="30.5" height="30.5" rx="9" fill="url(#bm)" stroke="oklch(1 0 0 / .14)" stroke-width="1.5"/>
<path d="M10.5 9.5v13M18.5 9.5v13M10.5 16h8" stroke="oklch(.965 .004 262)" stroke-width="2.25" stroke-linecap="round"/>
<circle cx="23.5" cy="21.5" r="1.9" fill="oklch(.72 .15 250)"/>`;

export function Dot(p: { tone: 'signal' | 'bone' | 'muted'; pulse?: boolean; hollow?: boolean }) {
  return <span class={['dot', p.tone, p.pulse ? 'pulse' : '', p.hollow ? 'hollow' : ''].filter(Boolean).join(' ')} aria-hidden="true"></span>;
}

const PILL_DOT: Record<Tone, Child> = {
  live: <Dot tone="signal" pulse />, positive: <Dot tone="signal" />, attention: <Dot tone="bone" hollow />,
  neutral: <Dot tone="bone" />, quiet: <Dot tone="muted" hollow />, void: <Dot tone="muted" />,
};

export function Pill(p: { tone: Tone; children?: Child }) {
  return <span class={`pill ${p.tone}`}>{PILL_DOT[p.tone]}{p.children}</span>;
}

export function StatusPill({ status }: { status: Status }) {
  return <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABELS[status] ?? status}</Pill>;
}

export function Layout(p: {
  title?: string; eyebrow?: string; description?: string; refresh?: boolean; banners?: string[]; error?: string;
  active?: string; attention?: number; wa?: string; children?: Child;
}) {
  const n = p.attention ?? 0;
  const banners = p.banners ?? [];
  const section = NAV.find(([h]) => h === p.active)?.[1] ?? 'Hub';
  const waOk = p.wa === 'conectado';
  return (
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {p.refresh ? <meta http-equiv="refresh" content="30" /> : null}
        <title>{p.title ? `${p.title} · Hub de ventas` : 'Hub de ventas'}</title>
        <link rel="preload" href="/fonts/Inter-Variable.woff2" as="font" type="font/woff2" crossorigin="" />
        <link rel="preload" href="/fonts/Sora-Variable.woff2" as="font" type="font/woff2" crossorigin="" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <aside class="sidebar">
          <a class="brand" href="/">
            <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">{raw(BRAND)}</svg>
            <span><b>Hub de ventas</b><span>Psicólogos · CRM</span></span>
          </a>
          <nav class="nav" aria-label="Principal">
            <p>Hub</p>
            <ul>
              {NAV.map(([href, label]) => (
                <li>
                  <a href={href} class={p.active === href ? 'on' : undefined} aria-current={p.active === href ? 'page' : undefined}>
                    <Icon d={ICONS[href]} />{label}
                    {href === '/' && n > 0 ? <span class="badge">{n}</span> : null}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {p.wa !== undefined ? (
            <div class="side-foot">
              <a class="status-card" href="/sistema">
                <div class="row"><span><Dot tone={waOk ? 'signal' : 'muted'} pulse={waOk} hollow={!waOk} />WhatsApp</span><span class="mono">{p.wa}</span></div>
                <div class="meter" aria-hidden="true"><i class={waOk ? 'on' : ''}></i><i class={n === 0 ? 'on' : ''}></i><i class={banners.length === 0 ? 'on' : ''}></i></div>
                <small>{banners.length === 0 ? 'Todo en orden' : banners.length === 1 ? '1 aviso abierto' : `${banners.length} avisos abiertos`}</small>
              </a>
            </div>
          ) : null}
        </aside>
        <div class="page-wrap">
          <header class="top">
            <p class="crumb" style="margin:0"><span>Hub de ventas</span><i>/</i><b>{section}</b></p>
            <div class="top-actions">
              {p.wa !== undefined ? <span class="chip"><Dot tone={waOk ? 'signal' : 'muted'} hollow={!waOk} />WhatsApp {p.wa}</span> : null}
              <a href="/" class={n > 0 ? 'btn primary' : 'btn'}>
                {n === 0 ? 'Nada pendiente' : n === 1 ? '1 conversación te necesita' : `${n} conversaciones te necesitan`}
              </a>
            </div>
          </header>
          <main id="main">
            <div class="content">
              {p.title ? (
                <header class="ph">
                  {p.eyebrow ? <p class="eyebrow">{p.eyebrow}</p> : null}
                  <h1>{p.title}</h1>
                  {p.description ? <p>{p.description}</p> : null}
                </header>
              ) : null}
              {p.error ? <div class="banner error" role="alert">{p.error}</div> : null}
              {banners.length > 0 ? (
                <section class="attn">
                  <div class="attn-h"><Dot tone="signal" />Necesita tu atención<span class="mono">{banners.length === 1 ? '1 aviso' : `${banners.length} avisos`}</span></div>
                  <ul class="notices">{banners.map((b) => <li class="banner">{b}</li>)}</ul>
                </section>
              ) : null}
              {p.children}
            </div>
          </main>
        </div>
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

// Inicial del nombre sin el título profesional (Lic., Dr., Dra.)
const initial = (name: string) => (name.replace(/^(lic|lic\.|dra?|dra?\.|psic|psic\.)\s+/i, '').trim()[0] ?? '?').toUpperCase();

export function ProspectList({ prospects, selectedId }: { prospects: Prospect[]; selectedId?: number }) {
  return (
    <div class="list">
      <div class="list-h"><span>Prospectos</span><span>{prospects.length}</span></div>
      {prospects.length === 0 ? <div class="empty">Todavía no hay prospectos.</div> : null}
      {prospects.map((p) => (
        <a class={p.id === selectedId ? 'item sel' : 'item'} href={`/p/${p.id}`}>
          <span class="avatar">{initial(p.name)}{p.needsAttention ? <span class="dot signal pulse" aria-label="Te necesita"></span> : null}</span>
          <span class="item-t"><strong>{p.name}</strong><small>{p.city ?? '—'}</small></span>
          <StatusPill status={p.status} />
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
  const facts: [string, string | null | undefined][] = [
    ['Ciudad', [x.city, x.province].filter(Boolean).join(', ')], ['Teléfono', x.phoneRaw], ['Email', x.email], ['Sitio web', x.website],
  ];
  return (
    <div class="detail">
      <div class="card">
        <div class="d-head">
          <div>
            <h2>{x.name}</h2>
            <small>{x.statusReason ? `Motivo: ${x.statusReason}` : null}{x.handedOff ? `${x.statusReason ? ' · ' : ''}Tomado por Lauri` : null}</small>
          </div>
          <StatusPill status={x.status} />
        </div>
        <dl class="facts" style="margin-bottom:0">
          {facts.filter(([, v]) => v).map(([k, v]) => <div><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {x.needsAttention ? <div class="need-line"><Dot tone="signal" pulse />{x.needsAttention}</div> : null}
        {x.fitNotes ? <pre>{x.fitNotes}</pre> : null}
      </div>
      <div class="card">
        <h3>Evaluación del agente</h3>
        {ev.stage || ev.summary ? (
          <div>
            {ev.stage ? <p><span class="tag" style="margin:0 8px 0 0">Etapa</span>{String(ev.stage)}</p> : null}
            {ev.summary ? <div style="color:var(--muted);line-height:1.65">{String(ev.summary)}</div> : null}
          </div>
        ) : <div style="color:var(--muted)">Sin evaluación todavía.</div>}
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
          {p.messages.length === 0 ? <div style="color:var(--muted)">Sin mensajes.</div> : null}
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

const VARIANT_TONE: Record<string, Tone> = { activa: 'live', candidata: 'attention', retirada: 'void' };

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
        {p.pending.length === 0 ? <div style="color:var(--muted)">No hay propuestas pendientes.</div> : null}
        {p.pending.map((x) => (
          <div class="card">
            <p><span class="tag" style="margin:0 8px 0 0">{kind[x.kind] ?? x.kind}</span>{x.summary}</p>
            <h4>Evidencia</h4><pre>{x.evidence}</pre>
            <h4>Contenido propuesto</h4><pre>{x.proposedContent}</pre>
            <div class="actions">
              <form method="post" action={`/proposals/${x.id}/approve`}>
                <button type="submit">Aprobar</button>
              </form>
              <form method="post" action={`/proposals/${x.id}/reject`}>
                <button class="no" type="submit">Rechazar</button>
              </form>
            </div>
          </div>
        ))}
      </div>
      <div class="card" style="overflow-x:auto">
        <h2>Aperturas (A/B)</h2>
        <table>
          <thead><tr><th>Variante</th><th>Estado</th><th>Contactos</th><th>Respuestas</th><th>Avanzaron</th><th>Veredicto</th></tr></thead>
          <tbody>
            {p.stats.map((s) => (
              <tr>
                <td><span class="mono">#{s.stat.variantId}</span><pre>{s.templates}</pre></td>
                <td><Pill tone={VARIANT_TONE[s.stat.status] ?? 'neutral'}>{s.stat.status}</Pill></td>
                <td class="mono">{s.stat.contacted}</td>
                <td class="mono">{s.stat.replied}</td>
                <td class="mono">{s.stat.advanced}</td>
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
        <Pill tone={p.waState === 'conectado' ? 'live' : p.waState === 'qr' ? 'attention' : 'quiet'}>{p.waState}</Pill>
        {p.qrDataUrl ? (
          <div style="margin-top:16px">
            <p style="color:var(--muted)">Escaneá este QR desde WhatsApp en tu celular (Dispositivos vinculados).</p>
            <img src={p.qrDataUrl} alt="QR de WhatsApp" width="280" height="280" />
          </div>
        ) : null}
      </div>
      <div class="card">
        <h2>Reuniones próximas</h2>
        {p.meetings.length === 0 ? <div style="color:var(--muted)">No hay reuniones próximas.</div> : null}
        <ul class="rows">
          {p.meetings.map((m) => (
            <li>
              <span class="mono" style="color:var(--muted)">{p.fmt(m.startsAt)}</span>
              <a href={`/p/${m.prospectId}`}>{p.names.get(m.prospectId) ?? `#${m.prospectId}`}</a>
              {m.meetUrl ? <a href={m.meetUrl} class="btn" style="margin-left:auto">Meet</a> : null}
            </li>
          ))}
        </ul>
      </div>
      <div class="card" style="overflow-x:auto">
        <h2>Últimos eventos</h2>
        <table>
          <tbody>
            {p.events.map((e) => (
              <tr><td class="t">{p.fmt(e.createdAt)}</td><td class="mono">{e.type}</td><td><small class="mono">{JSON.stringify(e.payload)}</small></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
