import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeLlm, AllProvidersFailedError } from '../src/llm/llm.js';
import type { PageSnapshot } from '../src/agents/buscador/browser.js';
import {
  hasPhoneHint, looksLikeTeam, loadQueries, loadInstructions, fillQuery, extractContacts, DEFAULT_QUERIES, DEFAULT_INSTRUCTIONS,
} from '../src/agents/buscador/extract.js';

const snap = (text: string, hrefs: string[] = []): PageSnapshot => ({ url: 'https://a.com', text, links: hrefs.map((href) => ({ href, text: '' })) });

describe('hasPhoneHint', () => {
  it('detecta teléfonos en texto y links', () => {
    expect(hasPhoneHint(snap('Tel: 351 15-612-3456'))).toBe(true);
    expect(hasPhoneHint(snap('Contacto', ['tel:+543516123456']))).toBe(true);
    expect(hasPhoneHint(snap('Escribime', ['https://wa.me/5493516123456']))).toBe(true);
    expect(hasPhoneHint(snap('Escribime', ['https://api.whatsapp.com/send?phone=5493516123456']))).toBe(true);
    expect(hasPhoneHint(snap('Atiendo de 9 a 18 hs, año 2024, cp 5000'))).toBe(false);
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

describe('extractContacts', () => {
  it('manda texto + links de contacto a la IA, recortado, con agente buscador y las instrucciones', async () => {
    let seen: { agent: string; system: string; content: string } | undefined;
    const llm = createFakeLlm((a) => {
      seen = { agent: a.agent, system: a.system, content: a.messages[0]!.content };
      return { contacts: [] };
    });
    const long = 'x'.repeat(20_000);
    await extractContacts(snap(`Lic. Ana ${long}`, ['tel:+543511111111', 'https://wa.me/5493512222222', 'mailto:ana@a.com', 'https://otra.com']), { llm, instructions: 'INSTR' });
    expect(seen!.agent).toBe('buscador');
    expect(seen!.system).toBe('INSTR');
    expect(seen!.content.length).toBeLessThanOrEqual(12_000);
    expect(seen!.content).toContain('tel:+543511111111');
    expect(seen!.content).toContain('https://wa.me/5493512222222');
    expect(seen!.content).toContain('mailto:ana@a.com');
    expect(seen!.content).not.toContain('https://otra.com');
  });
  it('devuelve los contactos de la IA', async () => {
    const llm = createFakeLlm(() => ({ contacts: [{ name: 'Lic. Ana Gómez', phone: '351 15 612-3456', email: 'ana@a.com' }, { name: 'Lic. Bea', phone: '+54 9 11 2222-3333' }] }));
    const out = await extractContacts(snap('Lic. Ana Gómez 351 15 612-3456 ana@a.com', ['https://wa.me/5491122223333']), { llm, instructions: 'I' });
    expect(out).toEqual([{ name: 'Lic. Ana Gómez', phone: '351 15 612-3456', email: 'ana@a.com' }, { name: 'Lic. Bea', phone: '+54 9 11 2222-3333' }]);
  });
  it('extractContacts descarta un celular que no aparece en la página', async () => {
    const llm = createFakeLlm(() => ({ contacts: [{ name: 'Lic. Inventada', phone: '351 999-8888' }, { name: 'Lic. Real', phone: '3516123456' }] }));
    const out = await extractContacts(snap('Lic. Real tel 351-612-3456'), { llm, instructions: 'I' });
    expect(out.map((c) => c.name)).toEqual(['Lic. Real']);
  });
  it('email vacío se omite', async () => {
    const llm = createFakeLlm(() => ({ contacts: [{ name: 'Lic. Real', phone: '3516123456', email: '' }] }));
    expect(await extractContacts(snap('3516123456'), { llm, instructions: 'I' })).toEqual([{ name: 'Lic. Real', phone: '3516123456' }]);
  });
  it('deja pasar AllProvidersFailedError; otro error -> []', async () => {
    const down = createFakeLlm(() => { throw new AllProvidersFailedError('sin modelos', []); });
    await expect(extractContacts(snap('3516123456'), { llm: down, instructions: 'I' })).rejects.toBeInstanceOf(AllProvidersFailedError);
    const weird = createFakeLlm(() => ({ nada: true }));
    expect(await extractContacts(snap('3516123456'), { llm: weird, instructions: 'I' })).toEqual([]);
  });
});
