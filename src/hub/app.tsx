import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { csrf } from 'hono/csrf';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import {
  EscalationNotOpenError, getEscalation, getProposal, getProspect, kvGet, listEvents, listManualVersions, listMessages,
  listOpenEscalations, listProposals, listProspectsForHub, listUpcomingMeetings, listVariants,
} from '../db/repo.js';
import { compareVariants, variantStats } from '../learning/stats.js';
import { approveProposal, rejectProposal } from '../learning/proposals.js';
import { PipelinePage, loadPipelineData } from './pipeline.js';
import { Layout, MetricsBar, ProposalsView, ProspectDetail, ProspectList, SystemView, computeMetrics } from './views.js';

// Tipografías propias (Sora, Inter y JetBrains Mono, licencia OFL) servidas por el hub: sin CDNs
const FONTS = new Set(['Sora-Variable.woff2', 'Inter-Variable.woff2', 'JetBrainsMono-Variable.woff2']);
const fontCache = new Map<string, Buffer>();

export interface HubDeps {
  db: Db;
  config: Config;
  answerEscalation: (id: number, answer: string) => Promise<void>;
}

export function createHubApp(deps: HubDeps) {
  const { db, config } = deps;
  const app = new Hono();
  const tz = config.tz ?? 'America/Argentina/Buenos_Aires';
  const fmt = (d: Date) => new Date(d).toLocaleString('es-AR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
  const withError = (path: string, msg: string) => `${path}?error=${encodeURIComponent(msg)}`;

  app.get('/health', (c) => c.text('ok'));
  app.get('/fonts/:name', (c) => {
    const name = c.req.param('name');
    if (!FONTS.has(name)) return c.notFound();
    let buf = fontCache.get(name);
    if (!buf) {
      buf = readFileSync(new URL(`./fonts/${name}`, import.meta.url));
      fontCache.set(name, buf);
    }
    return c.body(new Uint8Array(buf), 200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' });
  });
  // Sin HUB_PASSWORD el hub no pide contraseña (solo debe escuchar en 127.0.0.1)
  if (config.hubPassword) app.use('*', basicAuth({ username: config.hubUser, password: config.hubPassword }));
  // POST solo desde el propio hub: se compara el host del Origin (detrás del túnel el esquema puede diferir)
  app.use('*', csrf({
    origin: (origin, c) => {
      try {
        return new URL(origin).host === (c.req.header('host') ?? new URL(c.req.url).host);
      } catch {
        return false;
      }
    },
  }));

  async function banners(): Promise<string[]> {
    const out: string[] = [];
    if (!config.hubPassword) out.push('El hub no tiene contraseña. Está bien en tu computadora; antes de publicarlo en internet configurá HUB_PASSWORD.');
    if (config.dncMode === 'off') out.push('Atención: el registro No Llame está desactivado (DNC_MODE=off). Se puede contactar a números inscriptos.');
    if (await kvGet(db, 'dnc_error')) out.push('Falta el archivo del Registro No Llame (DNC_FILE). El buscador no agrega prospectos hasta que lo cargues.');
    if (await kvGet(db, 'pausa_nuevos')) out.push('Los contactos nuevos están en pausa.');
    const wa = await kvGet<{ state: string }>(db, 'wa_status');
    if (wa?.state !== 'conectado') out.push(`WhatsApp no está conectado (${wa?.state ?? 'sin estado'}). Revisá la pestaña Sistema.`);
    return out;
  }

  // Datos comunes del marco: avisos, cuántas conversaciones te necesitan y estado de WhatsApp
  async function chrome(active: string) {
    const attention = (await listProspectsForHub(db)).filter((p) => p.needsAttention).length;
    const wa = await kvGet<{ state: string }>(db, 'wa_status');
    return { banners: await banners(), attention, wa: wa?.state ?? 'sin estado', active };
  }

  async function home(c: any, selectedId?: number) {
    const prospects = await listProspectsForHub(db);
    let detail = null;
    let hasForm = false;
    if (selectedId !== undefined) {
      const prospect = prospects.find((p) => p.id === selectedId) ?? (await getProspect(db, selectedId));
      if (!prospect) return c.text('Prospecto inexistente', 404);
      const escalations = (await listOpenEscalations(db)).filter((e) => e.prospectId === prospect.id);
      hasForm = escalations.length > 0;
      detail = <ProspectDetail prospect={prospect} messages={await listMessages(db, prospect.id)} escalations={escalations} fmt={fmt} />;
    }
    return c.html(
      <Layout title="Prospectos" eyebrow="Centro de control" description="Todo lo que los agentes encontraron, conversaron y escalaron, actualizado en vivo." refresh={!hasForm} {...await chrome('/')} error={c.req.query('error')}>
        <MetricsBar m={computeMetrics(prospects)} />
        <div class="cols">
          <ProspectList prospects={prospects} selectedId={selectedId} />
          {detail}
        </div>
      </Layout>,
    );
  }

  app.get('/', (c) => home(c));
  app.get('/p/:id', (c) => {
    const id = Number(c.req.param('id'));
    return Number.isInteger(id) ? home(c, id) : c.text('Prospecto inexistente', 404);
  });

  app.post('/escalations/:id/answer', async (c) => {
    const id = Number(c.req.param('id'));
    const esc = Number.isInteger(id) ? await getEscalation(db, id) : undefined;
    if (!esc) return c.redirect('/');
    const back = `/p/${esc.prospectId}`;
    const answer = String((await c.req.parseBody()).answer ?? '').trim();
    if (!answer) return c.redirect(withError(back, 'Escribí una respuesta antes de enviar.'));
    try {
      await deps.answerEscalation(id, answer);
    } catch (e) {
      if (e instanceof EscalationNotOpenError) return c.redirect(withError(back, 'Esta consulta ya fue respondida.'));
      console.error('[hub] error al responder escalación', e);
      return c.redirect(withError(back, 'No se pudo enviar la respuesta (los proveedores de IA no respondieron). Probá de nuevo en un rato; la consulta sigue abierta.'));
    }
    return c.redirect(back);
  });

  app.get('/mejoras', async (c) => {
    const variants = await listVariants(db);
    const stats = await variantStats(db);
    const active = stats.find((s) => s.status === 'activa');
    const rows = stats.map((s) => {
      let verdict = '—';
      if (active && s.variantId !== active.variantId && s.status !== 'retirada') {
        const r = compareVariants(active, s, config.abMinPerVariant);
        if (r.verdict === 'insuficiente') {
          const faltan = Math.max(config.abMinPerVariant - active.contacted, config.abMinPerVariant - s.contacted, 0);
          verdict = `insuficiente: faltan ${faltan} contactos`;
        } else if (r.verdict === 'tendencia') verdict = 'tendencia sin confirmar';
        else verdict = 'confirmado';
      }
      return { stat: s, templates: variants.find((v) => v.id === s.variantId)?.template ?? '', verdict };
    });
    return c.html(
      <Layout title="Mejoras" eyebrow="Aprendizaje" description="Propuestas del analista, resultados de las aperturas A/B e historial del manual de ventas." {...await chrome('/mejoras')} error={c.req.query('error')}>
        <ProposalsView pending={await listProposals(db, 'pendiente')} stats={rows} manuals={await listManualVersions(db, 'ventas')} fmt={fmt} />
      </Layout>,
    );
  });

  const decide = (action: 'approve' | 'reject') => async (c: any) => {
    const id = Number(c.req.param('id'));
    try {
      const p = Number.isInteger(id) ? await getProposal(db, id) : undefined;
      if (!p) throw new Error('La propuesta no existe.');
      if (p.status !== 'pendiente') throw new Error(`La propuesta ya fue decidida (${p.status}).`);
      if (action === 'approve') await approveProposal(db, id);
      else await rejectProposal(db, id);
    } catch (e) {
      return c.redirect(withError('/mejoras', e instanceof Error ? e.message : 'No se pudo procesar la propuesta.'));
    }
    return c.redirect('/mejoras');
  };
  app.post('/proposals/:id/approve', decide('approve'));
  app.post('/proposals/:id/reject', decide('reject'));

  app.get('/sistema', async (c) => {
    const wa = await kvGet<{ state: string; qr?: string }>(db, 'wa_status');
    const qrDataUrl = wa?.state === 'qr' && wa.qr ? await QRCode.toDataURL(wa.qr, { width: 280 }) : undefined;
    const meetings = await listUpcomingMeetings(db, new Date());
    const names = new Map((await listProspectsForHub(db)).map((p) => [p.id, p.name]));
    return c.html(
      <Layout title="Sistema" eyebrow="Operación" description="Conexión de WhatsApp, reuniones agendadas y el registro de eventos." {...await chrome('/sistema')} error={c.req.query('error')}>
        <SystemView waState={wa?.state ?? 'sin estado'} qrDataUrl={qrDataUrl} events={await listEvents(db, 50)} meetings={meetings} names={names} fmt={fmt} />
      </Layout>,
    );
  });

  app.get('/pipeline', async (c) => {
    const d = await loadPipelineData(db, config, new Date());
    return c.html(<PipelinePage d={d} config={config} fmt={fmt} chrome={await chrome('/pipeline')} />);
  });

  return app;
}
