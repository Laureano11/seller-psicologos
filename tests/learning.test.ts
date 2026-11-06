import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { createFakeLlm, AllProvidersFailedError } from '../src/llm/llm.js';
import { compareVariants, variantStats, objectionCounts } from '../src/learning/stats.js';
import { runWeeklyAnalysis } from '../src/learning/analysis.js';
import { approveProposal, rejectProposal } from '../src/learning/proposals.js';
import type { Config } from '../src/config.js';

const config = { abMinPerVariant: 30 } as Config;
const NOW = new Date();
let db: Db;
let calls: number;
const llm = () => createFakeLlm((a) => {
  calls++;
  return a.system.includes('manual de ventas')
    ? { manual: 'MANUAL NUEVO', summary: 'resumen m', evidence: 'ev m' }
    : { template: 'Hola {nombre}, nueva', summary: 'resumen', evidence: 'ev' };
});
let n = 0;
async function contact(variantId: number | null, o: { replied?: boolean; status?: repo.Status; objections?: string[]; daysAgo?: number } = {}) {
  n++;
  const p = (await repo.insertProspect(db, {
    name: 'P' + n, waId: '54911' + String(n).padStart(8, '0'), status: o.status ?? 'contactado',
    openerVariantId: variantId, contactedAt: new Date(NOW.getTime() - (o.daysAgo ?? 1) * 86_400_000),
    tags: { objections: o.objections ?? [] },
  }))!;
  if (o.replied) await repo.addMessage(db, { prospectId: p.id, direction: 'in', author: 'prospect', body: 'hola' });
  return p;
}

beforeEach(async () => {
  db = await createMemoryDb();
  await migrate(db);
  await repo.addManualVersion(db, 'ventas', 'MANUAL VIEJO', 'archivo');
  calls = 0;
});

describe('compareVariants', () => {
  it('confirmado con datos suficientes', () => {
    const r = compareVariants({ contacted: 100, replied: 30 }, { contacted: 100, replied: 50 }, 30);
    expect(r.verdict).toBe('confirmado');
    expect(r.pValue!).toBeLessThan(0.05);
    expect(r.rateB).toBeGreaterThan(r.rateA);
  });
  it('insuficiente', () => {
    expect(compareVariants({ contacted: 10, replied: 3 }, { contacted: 10, replied: 5 }, 30)).toMatchObject({ verdict: 'insuficiente', pValue: null });
  });
  it('tendencia', () => {
    expect(compareVariants({ contacted: 40, replied: 12 }, { contacted: 40, replied: 15 }, 30).verdict).toBe('tendencia');
  });
});

describe('estadísticas', () => {
  it('variantStats cuenta contactados, respondieron y avanzaron', async () => {
    const v = await repo.addVariant(db, 'A', 'activa');
    await contact(v, { replied: true, status: 'interesado' });
    await contact(v);
    const s = await variantStats(db);
    expect(s).toEqual([{ variantId: v, status: 'activa', contacted: 2, replied: 1, advanced: 1 }]);
  });
  it('objectionCounts agrupa y respeta since', async () => {
    await contact(null, { objections: ['precio', 'tiempo'] });
    await contact(null, { objections: ['precio'] });
    await contact(null, { objections: ['precio'], daysAgo: 60 });
    const r = await objectionCounts(db, new Date(NOW.getTime() - 30 * 86_400_000));
    expect(r).toEqual([{ objection: 'precio', count: 2 }, { objection: 'tiempo', count: 1 }]);
  });
});

describe('runWeeklyAnalysis', () => {
  it('con 10 contactos no crea nada ni llama al llm', async () => {
    const v = await repo.addVariant(db, 'A', 'activa');
    for (let i = 0; i < 10; i++) await contact(v);
    expect(await runWeeklyAnalysis({ db, llm: llm(), config }, NOW)).toEqual({ created: 0 });
    expect(calls).toBe(0);
  });

  it('con 35 contactos sin candidata crea apertura_nueva y no duplica', async () => {
    const v = await repo.addVariant(db, 'A', 'activa');
    for (let i = 0; i < 35; i++) await contact(v);
    expect(await runWeeklyAnalysis({ db, llm: llm(), config }, NOW)).toEqual({ created: 1 });
    expect(await runWeeklyAnalysis({ db, llm: llm(), config }, NOW)).toEqual({ created: 0 });
    const ps = await repo.listProposals(db);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ kind: 'apertura_nueva', status: 'pendiente', proposedContent: 'Hola {nombre}, nueva' });
  });

  it('con 30+ contactos con objeciones propone manual completo', async () => {
    const v = await repo.addVariant(db, 'A', 'activa');
    const c = await repo.addVariant(db, 'B', 'candidata');
    for (let i = 0; i < 30; i++) await contact(i % 2 ? v : c, { objections: ['precio'] });
    expect(await runWeeklyAnalysis({ db, llm: llm(), config }, NOW)).toEqual({ created: 1 });
    expect((await repo.listProposals(db))[0]).toMatchObject({ kind: 'manual', proposedContent: 'MANUAL NUEVO' });
  });

  it('candidata confirmada mejor crea promover_apertura una sola vez', async () => {
    const a = await repo.addVariant(db, 'A', 'activa');
    const b = await repo.addVariant(db, 'B', 'candidata');
    for (let i = 0; i < 100; i++) await contact(a, { replied: i < 30 });
    for (let i = 0; i < 100; i++) await contact(b, { replied: i < 50 });
    expect(await runWeeklyAnalysis({ db, llm: llm(), config }, NOW)).toEqual({ created: 1 });
    expect(await runWeeklyAnalysis({ db, llm: llm(), config }, NOW)).toEqual({ created: 0 });
    expect((await repo.listProposals(db))[0]).toMatchObject({ kind: 'promover_apertura', targetId: b });
  });

  it('candidata confirmada peor se retira y se registra evento', async () => {
    const a = await repo.addVariant(db, 'A', 'activa');
    const b = await repo.addVariant(db, 'B', 'candidata');
    for (let i = 0; i < 100; i++) await contact(a, { replied: i < 50 });
    for (let i = 0; i < 100; i++) await contact(b, { replied: i < 30 });
    expect(await runWeeklyAnalysis({ db, llm: llm(), config }, NOW)).toEqual({ created: 0 });
    expect((await repo.listVariants(db, 'retirada')).map((v) => v.id)).toEqual([b]);
    expect((await repo.listEvents(db, 5)).some((e) => e.type === 'variante_retirada')).toBe(true);
  });

  it('si el llm falla registra evento y no tira', async () => {
    const v = await repo.addVariant(db, 'A', 'activa');
    for (let i = 0; i < 35; i++) await contact(v);
    const bad = createFakeLlm(() => { throw new AllProvidersFailedError('x', []); });
    expect(await runWeeklyAnalysis({ db, llm: bad, config }, NOW)).toEqual({ created: 0 });
    expect((await repo.listEvents(db, 5)).some((e) => e.type === 'analisis_error')).toBe(true);
  });
});

describe('approveProposal / rejectProposal', () => {
  it('apertura_nueva crea variante candidata', async () => {
    const id = await repo.addProposal(db, { kind: 'apertura_nueva', summary: 's', evidence: 'e', proposedContent: 'Hola nueva' });
    await approveProposal(db, id);
    const c = await repo.listVariants(db, 'candidata');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ template: 'Hola nueva', proposalId: id });
    expect((await repo.getProposal(db, id))!.status).toBe('aprobada');
  });
  it('promover_apertura activa la candidata y retira la activa', async () => {
    const a = await repo.addVariant(db, 'A', 'activa');
    const b = await repo.addVariant(db, 'B', 'candidata');
    const id = await repo.addProposal(db, { kind: 'promover_apertura', summary: 's', evidence: 'e', proposedContent: 'B', targetId: b });
    await approveProposal(db, id);
    expect((await repo.listVariants(db, 'activa')).map((v) => v.id)).toEqual([b]);
    expect((await repo.listVariants(db, 'retirada')).map((v) => v.id)).toEqual([a]);
  });
  it('manual crea nueva versión activa de ventas', async () => {
    const id = await repo.addProposal(db, { kind: 'manual', summary: 's', evidence: 'e', proposedContent: 'MANUAL NUEVO' });
    await approveProposal(db, id);
    expect(await repo.getActiveManual(db, 'ventas')).toBe('MANUAL NUEVO');
  });
  it('rechazar no cambia nada', async () => {
    const id = await repo.addProposal(db, { kind: 'manual', summary: 's', evidence: 'e', proposedContent: 'X' });
    await rejectProposal(db, id);
    expect(await repo.getActiveManual(db, 'ventas')).toBe('MANUAL VIEJO');
    expect((await repo.getProposal(db, id))!.status).toBe('rechazada');
  });
});
