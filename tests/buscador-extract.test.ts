import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  phoneInText, isBlacklisted, looksLikeTeam, loadQueries, loadInstructions, fillQuery, DEFAULT_QUERIES, DEFAULT_INSTRUCTIONS,
} from '../src/agents/buscador/extract.js';

describe('phoneInText', () => {
  it('encuentra el número en texto y en links tel: / wa.me del HTML', () => {
    expect(phoneInText('Tel: 351 15-612-3456', '3516123456')).toBe(true);
    expect(phoneInText('<a href="tel:+543516123456">Llamar</a>', '351 612 3456')).toBe(true);
    expect(phoneInText('<a href="https://wa.me/5493516123456">', '+54 9 351 612-3456')).toBe(true);
    expect(phoneInText('<a href="https://api.whatsapp.com/send?phone=5493516123456">', '3516123456')).toBe(true);
  });
  it('encuentra un número aunque esté pegado a otros', () => {
    expect(phoneInText('Tel 351 612 3456  351 111 1111', '3511111111')).toBe(true);
    expect(phoneInText('3516123456 3511111111', '3516123456')).toBe(true);
  });
  it('acepta el mismo número con o sin 15 / +54 9', () => {
    expect(phoneInText('Ana 351 15-612-3456 / Bea 011 15 2222-3333', '+54 9 11 2222-3333')).toBe(true);
  });
  it('rechaza un número que no está o con la característica inventada', () => {
    expect(phoneInText('Lic. Real tel 351-612-3456', '351 999-8888')).toBe(false);
    expect(phoneInText('Lic. Ana cel 15 612-3456', '351 612 3456')).toBe(false);
    expect(phoneInText('3516123456', 'no es un número')).toBe(false);
  });
});

describe('isBlacklisted', () => {
  it('redes sociales y URLs inválidas', () => {
    expect(isBlacklisted('https://ar.linkedin.com/in/x')).toBe(true);
    expect(isBlacklisted('https://www.instagram.com/ana')).toBe(true);
    expect(isBlacklisted('https://m.facebook.com/ana')).toBe(true);
    expect(isBlacklisted('https://x.com/ana')).toBe(true);
    expect(isBlacklisted('https://ana-psicologa.com')).toBe(false);
    expect(isBlacklisted('https://box.com')).toBe(false);
    expect(isBlacklisted('no es url')).toBe(true);
  });
});

describe('looksLikeTeam', () => {
  it('palabras de equipo, sin acentos ni mayúsculas', () => {
    expect(looksLikeTeam('Centro de Psicología Norte')).toBe(true);
    expect(looksLikeTeam('Lic. Clínica Pérez')).toBe(true);
    expect(looksLikeTeam('FUNDACION X')).toBe(true);
    expect(looksLikeTeam('Asociación Y')).toBe(true);
    expect(looksLikeTeam('Instituto Z')).toBe(true);
    expect(looksLikeTeam('Equipo Terapéutico')).toBe(true);
    expect(looksLikeTeam('Lic. Ana Gómez')).toBe(false);
    expect(looksLikeTeam('Lic. Centrone')).toBe(false);
  });
});

describe('archivos editables', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'busc-'));
  it('loadQueries ignora vacías y #; sin archivo -> defaults', () => {
    const d = dir();
    writeFileSync(join(d, 'buscador-consultas.md'), '<!-- comentario\nde varias líneas -->\n# título\n\npsicólogo {ciudad}\n  psicóloga {ciudad} {provincia}  \n');
    expect(loadQueries(d)).toEqual(['psicólogo {ciudad}', 'psicóloga {ciudad} {provincia}']);
    expect(loadQueries(dir())).toEqual(DEFAULT_QUERIES);
    expect(DEFAULT_QUERIES).toHaveLength(5);
  });
  it('loadInstructions lee el archivo; sin archivo -> default', () => {
    const d = dir();
    writeFileSync(join(d, 'buscador-instrucciones.md'), 'Extraé solo X');
    expect(loadInstructions(d)).toBe('Extraé solo X');
    expect(loadInstructions(dir())).toBe(DEFAULT_INSTRUCTIONS);
  });
  it('los archivos de content/ coinciden con los defaults', () => {
    expect(loadQueries('content')).toEqual(DEFAULT_QUERIES);
    expect(loadInstructions('content').length).toBeGreaterThan(100);
  });
  it('fillQuery', () => {
    expect(fillQuery('psicólogo {ciudad} {provincia}', { city: 'Rosario', province: 'Santa Fe' })).toBe('psicólogo Rosario Santa Fe');
  });
});
