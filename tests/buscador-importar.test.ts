import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryDb, migrate, type Db } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { createFakeTransport } from '../src/whatsapp/transport.js';
import { runImportador } from '../src/agents/buscador/importar.js';
import { readJson, writeJsonAtomic, type Psicologo } from '../src/agents/buscador/archivo.js';
import type { DncChecker } from '../src/dnc.js';

const NOW = new Date('2026-11-11T14:00:00.000Z');
const ps = (nombre: string, waId: string, extra: Partial<Psicologo> = {}): Psicologo => ({
  nombre, celular: waId.slice(3), waId, ciudad: 'Córdoba', provincia: 'Córdoba', pagina: `https://${nombre.length}.com`,
  encontradoEl: NOW.toISOString(), ...extra,
});

let db: Db;
beforeEach(async () => { db = await createMemoryDb(); await migrate(db); });
afterEach(async () => { await db.close(); });

function world(lista: Psicologo[], o: { dncBlocked?: string[]; dncMissing?: boolean; maxWaChecks?: number; withWa?: string[] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'busc-imp-'));
  writeJsonAtomic(join(dataDir, 'prospectos.json'), lista);
  const wa = createFakeTransport();
  for (const n of o.withWa ?? lista.map((p) => p.waId)) wa.whatsappNumbers.add(n);
  const dnc: DncChecker = {
    isBlocked: async (w) => Boolean(o.dncMissing) || (o.dncBlocked ?? []).includes(w),
    missingFile: () => (o.dncMissing ? '/no/existe.csv' : null),
  };
  const checks: string[] = [];
  const deps = {
    db, dnc, dataDir,
    wa: { hasWhatsApp: async (w: string) => { checks.push(w); return wa.whatsappNumbers.has(w); } },
    config: { buscador: { maxWaChecks: o.maxWaChecks ?? 50 } },
    sleep: async () => {},
  };
  return { deps, dataDir, checks };
}

describe('runImportador', () => {
  it('carga un psicólogo nuevo como encontrado, con fuente claude y link', async () => {
    const w = world([ps('Lic. Ana', '5493516123456', { email: 'ana@a.com' })]);
    const r = await runImportador(w.deps, NOW);
    expect(r).toMatchObject({ revisados: 1, cargados: 1, waChecks: 1, stopReason: 'fin' });
    const p = await repo.getProspectByWaId(db, '5493516123456');
    expect(p).toMatchObject({ name: 'Lic. Ana', email: 'ana@a.com', city: 'Córdoba', status: 'encontrado', source: 'claude', sourceRef: 'https://8.com' });
    const evs = await repo.listEvents(db, 10);
    expect(evs.some((e) => e.type === 'buscador_import')).toBe(true);
  });

  it('no vuelve a revisar a los que ya están en la base', async () => {
    const w = world([ps('Lic. Ana', '5493516123456')]);
    await runImportador(w.deps, NOW);
    const r = await runImportador(w.deps, NOW);
    expect(r).toMatchObject({ revisados: 0, cargados: 0 });
    expect(w.checks).toHaveLength(1);
  });

  it('baja y No Llame: descarte registrado, sin consultar WhatsApp ni repetir', async () => {
    await repo.insertProspect(db, { name: 'x', waId: '5493511111111', status: 'encontrado' });
    const p = await repo.getProspectByWaId(db, '5493511111111');
    await repo.applyOptOut(db, p!.id, 'baja');
    await db.query("DELETE FROM prospects WHERE wa_id='5493511111111'");
    const w = world([ps('Lic. Baja', '5493511111111'), ps('Lic. NoLlame', '5493512222222')], { dncBlocked: ['5493512222222'] });
    const r = await runImportador(w.deps, NOW);
    expect(r.descartes).toEqual({ baja: 1, no_llame: 1 });
    expect(w.checks).toEqual([]);
    expect(await repo.kvGet(db, 'importador_descartados')).toEqual({ '5493511111111': 'baja', '5493512222222': 'no_llame' });
    expect((await runImportador(w.deps, NOW)).revisados).toBe(0);
  });

  it('sin WhatsApp: se recuerda y no se vuelve a consultar', async () => {
    const w = world([ps('Lic. SinWa', '5493513333333')], { withWa: [] });
    const r = await runImportador(w.deps, NOW);
    expect(r.descartes).toEqual({ sin_whatsapp: 1 });
    await runImportador(w.deps, NOW);
    expect(w.checks).toEqual(['5493513333333']);
  });

  it('corta al llegar al tope diario de consultas a WhatsApp', async () => {
    const w = world([ps('Lic. A', '5493516123456'), ps('Lic. B', '5493511111111')], { maxWaChecks: 1 });
    const r = await runImportador(w.deps, NOW);
    expect(r).toMatchObject({ cargados: 1, waChecks: 1, stopReason: 'tope_whatsapp' });
    const r2 = await runImportador(w.deps, NOW);
    expect(r2).toMatchObject({ cargados: 0, waChecks: 0, stopReason: 'tope_whatsapp' });
    const r3 = await runImportador(w.deps, new Date('2026-11-12T14:00:00.000Z'));
    expect(r3).toMatchObject({ cargados: 1 });
  });

  it('sin archivo No Llame no carga a nadie', async () => {
    const w = world([ps('Lic. Ana', '5493516123456')], { dncMissing: true });
    const r = await runImportador(w.deps, NOW);
    expect(r).toMatchObject({ cargados: 0, stopReason: 'sin_no_llame' });
    expect(w.checks).toEqual([]);
  });

  it('sin prospectos.json o con uno roto no hace nada', async () => {
    const w = world([]);
    writeJsonAtomic(join(w.dataDir, 'prospectos.json'), { roto: true });
    expect(await runImportador(w.deps, NOW)).toMatchObject({ revisados: 0, stopReason: 'fin' });
  });

  it('publica las bajas en bajas.json', async () => {
    await repo.insertProspect(db, { name: 'x', waId: '5493514444444', status: 'contactado' });
    const p = await repo.getProspectByWaId(db, '5493514444444');
    await repo.applyOptOut(db, p!.id, 'baja');
    const w = world([]);
    await runImportador(w.deps, NOW);
    expect(readJson(join(w.dataDir, 'bajas.json'), null)).toEqual(['5493514444444']);
  });

  it('se corta si se aborta', async () => {
    const w = world([ps('Lic. A', '5493516123456')]);
    const ac = new AbortController();
    ac.abort();
    expect(await runImportador(w.deps, NOW, ac.signal)).toMatchObject({ cargados: 0, stopReason: 'cancelado' });
  });
});
