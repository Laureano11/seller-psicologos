import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toWaId } from '../../phone.js';

/** Respaldo si falta content/buscador-consultas.md (mismo contenido que ese archivo). */
export const DEFAULT_QUERIES = [
  'psicólogo {ciudad} whatsapp',
  'psicóloga {ciudad} consultorio',
  'listado psicólogos {ciudad} {provincia}',
  'cartilla psicólogos {ciudad}',
  'psicólogo particular {ciudad} turnos',
];

/** Respaldo si falta content/buscador-instrucciones.md. */
export const DEFAULT_INSTRUCTIONS = `Sos el Buscador. Con el navegador, buscá psicólogos y psicólogas individuales de Argentina
y devolvé su nombre, su celular y su email (solo si aparece), con el link de la página donde figura el celular.
Ignorá centros, institutos, clínicas, fundaciones, asociaciones y equipos. Copiá los datos textuales: no inventes ni completes.
No entres a redes sociales, no completes formularios, no hagas login y no resuelvas CAPTCHAs.`;

const TEAM_WORDS = ['centro', 'instituto', 'equipo', 'fundacion', 'clinica', 'asociacion'];
const PHONE_RUN = /\+?\d[\d\s().-]{6,}\d/g;

/** Dominios que el Buscador nunca usa como fuente (redes sociales; LinkedIn descartado por decisión de Lauri). */
export const BLACKLIST = ['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com'];

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** URL inválida, no http(s) o de una red social. */
export function isBlacklisted(url: string): boolean {
  const host = hostOf(url);
  return !host || BLACKLIST.some((d) => host === d || host.endsWith(`.${d}`));
}

export function looksLikeTeam(name: string): boolean {
  const words = fold(name).split(/[^a-z]+/);
  return TEAM_WORDS.some((w) => words.includes(w));
}

/**
 * ¿El celular figura escrito en la página (texto o HTML, incluidos links tel: / wa.me)?
 * Compara números normalizados: tolera "15" / "+54 9" pero no una característica inventada.
 */
export function phoneInText(text: string, phone: string): boolean {
  const id = toWaId(phone);
  if (!id) return false;
  // celular argentino: los 10 dígitos (área + número) o con el "15" después del área, dentro de un tramo de dígitos
  // (un tramo puede juntar varios números separados por espacios)
  const national = id.startsWith('549') ? id.slice(3) : null;
  const forms = national ? [national, ...[2, 3, 4].map((a) => national.slice(0, a) + '15' + national.slice(a))] : [];
  return (text.match(PHONE_RUN) ?? []).some((run) => {
    const d = run.replace(/\D/g, '');
    return toWaId(run) === id || forms.some((f) => d.includes(f));
  });
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
