import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCorrida } from '../src/agents/buscador/corrida.js';
import { readJson, writeJsonAtomic, type Psicologo } from '../src/agents/buscador/archivo.js';
import { buildPrompt, parseClaudeOutput, type Hallazgo } from '../src/agents/buscador/claude.js';
import { CITIES } from '../src/agents/buscador/cities.js';

const NOW = new Date('2026-11-11T14:00:00.000Z');
const content = () => {
  const d = mkdtempSync(join(tmpdir(), 'busc-content-'));
  writeFileSync(join(d, 'buscador-consultas.md'), 'psicólogo {ciudad}\n');
  writeFileSync(join(d, 'buscador-instrucciones.md'), 'INSTRUCCIONES');
  return d;
};
const h = (nombre: string, celular: string, pagina = 'https://ana.com', email?: string): Hallazgo =>
  (email ? { nombre, celular, pagina, email } : { nombre, celular, pagina });

/** Mundo de prueba: Claude falso que devuelve `hallazgos`, y páginas que contienen los números de `paginas`. */
function world(hallazgos: Hallazgo[] | Error, paginas: Record<string, string> = { 'https://ana.com': '3516123456 3511111111 3512222222' }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'busc-data-'));
  const prompts: string[] = [];
  const deps = {
    dataDir, contentDir: content(), max: 10, now: NOW,
    claude: async (p: string) => { prompts.push(p); if (hallazgos instanceof Error) throw hallazgos; return hallazgos; },
    fetchPage: async (url: string) => { const t = paginas[url]; if (t === undefined) throw new Error('404'); return t; },
  };
  const prospectos = () => readJson<Psicologo[]>(join(dataDir, 'prospectos.json'), []);
  return { deps, dataDir, prompts, prospectos };
}

describe('runCorrida', () => {
  it('guarda un psicólogo válido con todos los campos', async () => {
    const w = world([h('Lic. Ana Gómez', '351 15-612-3456', 'https://ana.com', 'ana@a.com')]);
    const r = await runCorrida(w.deps);
    expect(r.guardados).toBe(1);
    expect(w.prospectos()).toEqual([{
      nombre: 'Lic. Ana Gómez', celular: '351 15-612-3456', waId: '5493516123456', email: 'ana@a.com',
      ciudad: CITIES[0]!.city, provincia: CITIES[0]!.province, pagina: 'https://ana.com', encontradoEl: NOW.toISOString(),
    }]);
  });

  it('descarta por cada motivo', async () => {
    const w = world([
      h('Centro Psicológico Norte', '3511111111'),
      h('Lic. Sin Tel', 'no tengo'),
      h('Lic. Insta', '3511111111', 'https://instagram.com/x'),
      h('Lic. Baja', '3512222222'),
      h('Lic. Inventada', '3519998888'),
      h('Lic. Caída', '3511111111', 'https://caida.com'),
    ]);
    writeJsonAtomic(join(w.dataDir, 'bajas.json'), ['5493512222222']);
    const r = await runCorrida(w.deps);
    expect(r.guardados).toBe(0);
    expect(r.descartes).toEqual({ equipo: 1, sin_telefono: 1, red_social: 1, baja: 1, no_en_pagina: 2 });
  });

  it('no duplica dentro de la corrida ni contra el archivo, y pasa los conocidos al prompt', async () => {
    const w = world([h('Lic. Ana', '3516123456'), h('Ana otra vez', '+54 9 351 612-3456'), h('Lic. Bea', '3511111111')]);
    writeJsonAtomic(join(w.dataDir, 'prospectos.json'), [{
      nombre: 'Lic. Bea', celular: '3511111111', waId: '5493511111111', ciudad: CITIES[0]!.city, provincia: 'X', pagina: 'https://b.com', encontradoEl: 'x',
    }]);
    const r = await runCorrida(w.deps);
    expect(r.guardados).toBe(1);
    expect(r.descartes).toEqual({ duplicado: 2 });
    expect(w.prospectos().map((p) => p.waId)).toEqual(['5493511111111', '5493516123456']);
    expect(w.prompts[0]).toContain('5493511111111');
  });

  it('borra del archivo a los de bajas.json', async () => {
    const w = world([]);
    writeJsonAtomic(join(w.dataDir, 'prospectos.json'), [
      { nombre: 'A', celular: '3511111111', waId: '5493511111111', ciudad: 'X', provincia: 'X', pagina: 'p', encontradoEl: 'x' },
      { nombre: 'B', celular: '3512222222', waId: '5493512222222', ciudad: 'X', provincia: 'X', pagina: 'p', encontradoEl: 'x' },
    ]);
    writeJsonAtomic(join(w.dataDir, 'bajas.json'), ['5493512222222']);
    const r = await runCorrida(w.deps);
    expect(r.borradosPorBaja).toBe(1);
    expect(w.prospectos().map((p) => p.nombre)).toEqual(['A']);
  });

  it('avanza la ciudad, da la vuelta y guarda el informe', async () => {
    const w = world([]);
    await runCorrida(w.deps);
    expect(readJson(join(w.dataDir, 'buscador-estado.json'), null)).toEqual({ ciudad: 1 });
    writeJsonAtomic(join(w.dataDir, 'buscador-estado.json'), { ciudad: CITIES.length - 1 });
    const r = await runCorrida(w.deps);
    expect(r.ciudad).toBe(CITIES[CITIES.length - 1]!.city);
    expect(w.prompts[1]).toContain(CITIES[CITIES.length - 1]!.city);
    expect(readJson(join(w.dataDir, 'buscador-estado.json'), null)).toEqual({ ciudad: 0 });
    expect(readJson<unknown[]>(join(w.dataDir, 'buscador-corridas.json'), [])).toHaveLength(2);
  });

  it('si Claude falla, no toca el archivo ni avanza la ciudad', async () => {
    const w = world(new Error('sin sesión'));
    await expect(runCorrida(w.deps)).rejects.toThrow('sin sesión');
    expect(readJson(join(w.dataDir, 'prospectos.json'), null)).toBeNull();
    expect(readJson(join(w.dataDir, 'buscador-estado.json'), null)).toBeNull();
  });

  it('respeta el máximo por corrida', async () => {
    const w = world([h('Lic. A', '3516123456'), h('Lic. B', '3511111111'), h('Lic. C', '3512222222')]);
    const r = await runCorrida({ ...w.deps, max: 2 });
    expect(r.guardados).toBe(2);
    expect(w.prompts[0]).toContain('como máximo 2');
  });
});

describe('claude', () => {
  it('buildPrompt arma consultas de la ciudad, máximo y conocidos', () => {
    const p = buildPrompt({ instructions: 'I', queries: ['psicólogo {ciudad} {provincia}'], city: { city: 'Rosario', province: 'Santa Fe' }, max: 7, conocidos: [] });
    expect(p).toContain('- psicólogo Rosario Santa Fe');
    expect(p).toContain('como máximo 7');
    expect(p).toContain('(ninguno)');
  });
  it('parseClaudeOutput lee structured_output y limpia', () => {
    const out = JSON.stringify({ is_error: false, structured_output: { psicologos: [
      { nombre: ' Ana ', celular: '351', pagina: 'https://a.com', email: '' }, { nombre: 'sin pagina', celular: '1' },
    ] } });
    expect(parseClaudeOutput(out)).toEqual([{ nombre: 'Ana', celular: '351', pagina: 'https://a.com' }]);
  });
  it('parseClaudeOutput lanza si no es JSON, si hubo error o si falta la lista', () => {
    expect(() => parseClaudeOutput('Not logged in')).toThrow('no devolvió JSON');
    expect(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: 'boom' }))).toThrow('boom');
    expect(() => parseClaudeOutput(JSON.stringify({ result: 'x' }))).toThrow('lista');
  });
});
