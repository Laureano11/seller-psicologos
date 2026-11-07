import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AllProvidersFailedError, type Llm } from '../../llm/llm.js';
import type { PageSnapshot } from './browser.js';

export type Contact = { name: string; phone: string; email?: string };

/** Respaldo si falta content/buscador-consultas.md (mismo contenido que ese archivo). */
export const DEFAULT_QUERIES = [
  'psicólogo {ciudad} whatsapp',
  'psicóloga {ciudad} consultorio',
  'listado psicólogos {ciudad} {provincia}',
  'cartilla psicólogos {ciudad}',
  'psicólogo particular {ciudad} turnos',
];

/** Respaldo si falta content/buscador-instrucciones.md. */
export const DEFAULT_INSTRUCTIONS = `Te paso el texto de una página web de Argentina y sus links de contacto.
Devolvé la lista de psicólogos y psicólogas individuales que aparecen, con "name", "phone" y "email" (solo si aparece).
Ignorá centros, institutos, clínicas, fundaciones, asociaciones y equipos. Copiá los datos textuales: no inventes ni completes.
Si una persona no tiene teléfono en la página, no la incluyas. Si no hay ninguno, devolvé una lista vacía.`;

const MAX_CHARS = 12_000;
const TEAM_WORDS = ['centro', 'instituto', 'equipo', 'fundacion', 'clinica', 'asociacion'];
const PHONE_RUN = /\+?\d[\d\s().-]{6,}\d/g;

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const digits = (s: string) => s.replace(/\D/g, '');
const isContactLink = (href: string) => /^(tel:|mailto:)/i.test(href) || /(wa\.me\/|api\.whatsapp\.com\/send)/i.test(href);

/** Tramos de dígitos con forma de teléfono (8+ dígitos) en el texto y en los links de contacto. */
function phoneRuns(s: PageSnapshot): string[] {
  const runs = (s.text.match(PHONE_RUN) ?? []).map(digits);
  for (const { href } of s.links) if (isContactLink(href)) runs.push(digits(href));
  return runs.filter((r) => r.length >= 8);
}

export function hasPhoneHint(s: PageSnapshot): boolean {
  return phoneRuns(s).length > 0;
}

export function looksLikeTeam(name: string): boolean {
  const words = fold(name).split(/[^a-z]+/);
  return TEAM_WORDS.some((w) => words.includes(w));
}

function readContent(contentDir: string, file: string): string | null {
  try {
    return readFileSync(join(contentDir, file), 'utf8');
  } catch {
    return null;
  }
}

export function loadInstructions(contentDir: string): string {
  return readContent(contentDir, 'buscador-instrucciones.md')?.trim() || DEFAULT_INSTRUCTIONS;
}

export function loadQueries(contentDir: string): string[] {
  const raw = readContent(contentDir, 'buscador-consultas.md');
  if (!raw) return DEFAULT_QUERIES;
  const lines = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return lines.length ? lines : DEFAULT_QUERIES;
}

export function fillQuery(tpl: string, q: { city: string; province: string }): string {
  return tpl.replaceAll('{ciudad}', q.city).replaceAll('{provincia}', q.province);
}

const schema = z.object({
  contacts: z.array(z.object({ name: z.string(), phone: z.string(), email: z.string().optional() })),
});

/** Pide a la IA los psicólogos de la página. Descarta celulares que no aparecen en la página (anti-invención). */
export async function extractContacts(s: PageSnapshot, deps: { llm: Llm; instructions: string }): Promise<Contact[]> {
  const contactLinks = s.links.map((l) => l.href).filter(isContactLink);
  const header = `Página: ${s.url}\nLinks de contacto:\n${contactLinks.join('\n') || '(ninguno)'}\n\nTexto:\n`;
  const content = (header + s.text).slice(0, MAX_CHARS);
  let out: z.infer<typeof schema>;
  try {
    out = await deps.llm.object({ agent: 'buscador', system: deps.instructions, messages: [{ role: 'user', content }], schema });
  } catch (e) {
    if (e instanceof AllProvidersFailedError) throw e;
    return [];
  }
  const runs = phoneRuns(s);
  const inPage = (phone: string) => {
    const tail = digits(phone).slice(-7);
    return tail.length === 7 && runs.some((r) => r.includes(tail));
  };
  return out.contacts
    .filter((c) => c.name.trim() && inPage(c.phone))
    .map((c) => {
      const email = c.email?.trim();
      return email ? { name: c.name.trim(), phone: c.phone.trim(), email } : { name: c.name.trim(), phone: c.phone.trim() };
    });
}
