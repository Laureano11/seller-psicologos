import type { Db } from '../db/db.js';

export type VariantStat = { variantId: number; status: string; contacted: number; replied: number; advanced: number };

export async function variantStats(db: Db): Promise<VariantStat[]> {
  const rows = await db.query<{ variant_id: number; status: string; contacted: number; replied: number; advanced: number }>(
    `SELECT v.id AS variant_id, v.status,
       count(p.id)::int AS contacted,
       count(p.id) FILTER (WHERE EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'in'))::int AS replied,
       count(p.id) FILTER (WHERE p.status IN ('interesado','reunion_agendada','listo_para_cerrar'))::int AS advanced
     FROM opener_variants v
     LEFT JOIN prospects p ON p.opener_variant_id = v.id AND p.contacted_at IS NOT NULL
     GROUP BY v.id, v.status ORDER BY v.id`,
  );
  return rows.map((r) => ({ variantId: r.variant_id, status: r.status, contacted: r.contacted, replied: r.replied, advanced: r.advanced }));
}

/** Objeciones de prospectos contactados desde `since`, de mayor a menor frecuencia. */
export async function objectionCounts(db: Db, since: Date): Promise<{ objection: string; count: number }[]> {
  return db.query(
    `SELECT o AS objection, count(*)::int AS count
     FROM prospects p, jsonb_array_elements_text(COALESCE(p.tags->'objections', '[]'::jsonb)) AS o
     WHERE p.contacted_at >= $1
     GROUP BY o ORDER BY count DESC, o`,
    [since],
  );
}

// Abramowitz-Stegun 7.1.26
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}
const normalCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

type Arm = { contacted: number; replied: number };

export function compareVariants(
  a: Arm,
  b: Arm,
  minPer: number,
): { verdict: 'insuficiente' | 'tendencia' | 'confirmado'; pValue: number | null; rateA: number; rateB: number } {
  const rateA = a.contacted > 0 ? a.replied / a.contacted : 0;
  const rateB = b.contacted > 0 ? b.replied / b.contacted : 0;
  if (a.contacted < minPer || b.contacted < minPer) return { verdict: 'insuficiente', pValue: null, rateA, rateB };
  const pooled = (a.replied + b.replied) / (a.contacted + b.contacted);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.contacted + 1 / b.contacted));
  if (se === 0) return { verdict: 'tendencia', pValue: 1, rateA, rateB };
  const z = (rateB - rateA) / se;
  const pValue = Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  return { verdict: pValue < 0.05 ? 'confirmado' : 'tendencia', pValue, rateA, rateB };
}
