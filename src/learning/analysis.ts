import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { addProposal, listProposals, listVariants, logEvent, setVariantStatus, type ProposalKind } from '../db/repo.js';
import type { Llm } from '../llm/llm.js';
import { loadKnowledge } from '../agents/vendedor/knowledge.js';
import { compareVariants, objectionCounts, variantStats } from './stats.js';

const DAY = 86_400_000;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const openerSchema = z.object({ template: z.string().min(1), summary: z.string().min(1), evidence: z.string().min(1) });
const manualSchema = z.object({ manual: z.string().min(1), summary: z.string().min(1), evidence: z.string().min(1) });

export async function runWeeklyAnalysis(deps: { db: Db; llm: Llm; config: Config }, now: Date): Promise<{ created: number }> {
  const { db, llm, config } = deps;
  const min = config.abMinPerVariant;
  let created = 0;

  const hasPending = async (kind: ProposalKind, targetId?: number) =>
    (await listProposals(db, 'pendiente')).some((p) => p.kind === kind && (targetId === undefined || p.targetId === targetId));

  const stats = await variantStats(db);
  const active = stats.find((s) => s.status === 'activa');
  const candidate = stats.find((s) => s.status === 'candidata');

  // 1-2: A/B activa vs candidata
  if (active && candidate) {
    const cmp = compareVariants(active, candidate, min);
    if (cmp.verdict === 'confirmado') {
      const evidence =
        `Activa: ${active.replied}/${active.contacted} respuestas (${pct(cmp.rateA)}). ` +
        `Candidata: ${candidate.replied}/${candidate.contacted} respuestas (${pct(cmp.rateB)}). p=${cmp.pValue!.toFixed(4)}.`;
      if (cmp.rateB > cmp.rateA) {
        if (!(await hasPending('promover_apertura', candidate.variantId))) {
          const v = (await listVariants(db, 'candidata')).find((x) => x.id === candidate.variantId)!;
          await addProposal(db, {
            kind: 'promover_apertura',
            summary: 'La apertura candidata responde mejor que la activa: promoverla.',
            evidence,
            proposedContent: v.template,
            targetId: candidate.variantId,
          });
          created++;
        }
      } else {
        await setVariantStatus(db, candidate.variantId, 'retirada');
        await logEvent(db, 'variante_retirada', { variantId: candidate.variantId, evidence });
      }
    }
  }

  try {
    // 3: nueva apertura
    if (!candidate && active && !(await hasPending('apertura_nueva'))) {
      const last = await db.query<{ created_at: Date }>(
        "SELECT created_at FROM proposals WHERE kind='apertura_nueva' ORDER BY created_at DESC, id DESC LIMIT 1",
      );
      const since = last[0]?.created_at ?? null;
      const n = (await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM prospects WHERE contacted_at IS NOT NULL AND ($1::timestamptz IS NULL OR contacted_at > $1)',
        [since],
      ))[0].n;
      if (n >= min) {
        const objections = await objectionCounts(db, new Date(now.getTime() - 30 * DAY));
        const current = (await listVariants(db, 'activa'))[0]?.template ?? '';
        const kn = await loadKnowledge(db);
        const out = await llm.object({
          agent: 'analista',
          system:
            'Sos el analista de un equipo de ventas que contacta psicólogos en Argentina por WhatsApp. ' +
            'Proponé una nueva variante del mensaje de apertura, en español rioplatense, breve y natural, para testear contra la actual. ' +
            'Devolvé el texto de la apertura (template), un resumen de qué cambia y por qué (summary) y la evidencia en que te basás (evidence).\n\n' +
            `Manual de ventas:\n${kn.ventas}\n\nEstilo:\n${kn.estilo}`,
          messages: [{
            role: 'user',
            content:
              `Apertura activa:\n${current}\n\n` +
              `Estadísticas por variante:\n${stats.map((s) => `- #${s.variantId} (${s.status}): ${s.contacted} contactos, ${s.replied} respuestas, ${s.advanced} avanzaron`).join('\n')}\n\n` +
              `Objeciones frecuentes:\n${objections.map((o) => `- ${o.objection} (${o.count})`).join('\n') || '- ninguna'}`,
          }],
          schema: openerSchema,
        });
        await addProposal(db, { kind: 'apertura_nueva', summary: out.summary, evidence: out.evidence, proposedContent: out.template });
        created++;
      }
    }

    // 4: mejora del manual de ventas
    if (!(await hasPending('manual'))) {
      const since = new Date(now.getTime() - 30 * DAY);
      const n = (await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM prospects
         WHERE contacted_at >= $1 AND jsonb_array_length(COALESCE(tags->'objections', '[]'::jsonb)) > 0`,
        [since],
      ))[0].n;
      if (n >= min) {
        const objections = await objectionCounts(db, since);
        const kn = await loadKnowledge(db);
        const out = await llm.object({
          agent: 'analista',
          system:
            'Sos el analista de un equipo de ventas que contacta psicólogos en Argentina por WhatsApp. ' +
            'Mejorá el manual de ventas para manejar mejor las objeciones más frecuentes. Respondé en español rioplatense. ' +
            'Devolvé el manual completo nuevo (manual), un resumen de los cambios (summary) y la evidencia (evidence).',
          messages: [{
            role: 'user',
            content:
              `Manual de ventas actual:\n${kn.ventas}\n\n` +
              `Objeciones de los últimos 30 días (${n} contactos con objeciones):\n${objections.map((o) => `- ${o.objection} (${o.count})`).join('\n')}`,
          }],
          schema: manualSchema,
        });
        await addProposal(db, { kind: 'manual', summary: out.summary, evidence: out.evidence, proposedContent: out.manual });
        created++;
      }
    }
  } catch (e) {
    await logEvent(db, 'analisis_error', { error: e instanceof Error ? e.message : String(e) });
  }

  return { created };
}
