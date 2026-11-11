import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../src/agents/buscador/archivo.js';

const dir = () => mkdtempSync(join(tmpdir(), 'busc-arch-'));

describe('archivos JSON', () => {
  it('inexistente o corrupto -> fallback', () => {
    const d = dir();
    expect(readJson(join(d, 'no.json'), [])).toEqual([]);
    writeFileSync(join(d, 'mal.json'), '{ esto no es json');
    expect(readJson(join(d, 'mal.json'), { a: 1 })).toEqual({ a: 1 });
  });

  it('escribe y lee, sin dejar el temporal', () => {
    const d = dir();
    const f = join(d, 'sub', 'x.json');
    writeJsonAtomic(f, [{ nombre: 'Ana' }]);
    expect(readJson(f, [])).toEqual([{ nombre: 'Ana' }]);
    expect(readdirSync(join(d, 'sub'))).toEqual(['x.json']);
  });
});
