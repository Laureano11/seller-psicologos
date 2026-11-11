import { join } from 'node:path';
import { toWaId } from '../../phone.js';
import { CITIES } from './cities.js';
import { buildPrompt, type ClaudeRunner } from './claude.js';
import { isBlacklisted, loadInstructions, loadQueries, looksLikeTeam, phoneInText } from './extract.js';
import { BAJAS_FILE, CORRIDAS_FILE, ESTADO_FILE, PROSPECTOS_FILE, readJson, writeJsonAtomic, type Psicologo } from './archivo.js';

export type CorridaResult = {
  ciudad: string;
  hallados: number;
  guardados: number;
  descartes: Record<string, number>;
  borradosPorBaja: number;
  at: string;
};

export type CorridaDeps = {
  dataDir: string;
  contentDir: string;
  claude: ClaudeRunner;
  /** Descarga la página (HTML o texto) para confirmar que el celular figura ahí. */
  fetchPage: (url: string) => Promise<string>;
  max: number;
  now: Date;
};

/** Corridas que se guardan en buscador-corridas.json. */
const MAX_CORRIDAS = 50;

/**
 * Una corrida en la Mac: limpia bajas, lanza Claude para la ciudad que toca, filtra
 * (equipo → sin teléfono → red social → baja → duplicado → no figura en la página),
 * agrega los nuevos a prospectos.json y avanza a la próxima ciudad. Si Claude falla, no toca nada.
 */
export async function runCorrida(d: CorridaDeps): Promise<CorridaResult> {
  const file = (name: string) => join(d.dataDir, name);
  const bajas = new Set(readJson<string[]>(file(BAJAS_FILE), []));
  const previos = readJson<Psicologo[]>(file(PROSPECTOS_FILE), []);
  const lista = previos.filter((p) => !bajas.has(p.waId));
  const borradosPorBaja = previos.length - lista.length;

  const estado = readJson<{ ciudad?: unknown }>(file(ESTADO_FILE), {});
  const idx = Number.isInteger(estado.ciudad) && (estado.ciudad as number) >= 0 && (estado.ciudad as number) < CITIES.length
    ? (estado.ciudad as number) : 0;
  const city = CITIES[idx]!;

  const conocidos = new Set(lista.map((p) => p.waId));
  const prompt = buildPrompt({
    instructions: loadInstructions(d.contentDir),
    queries: loadQueries(d.contentDir),
    city,
    max: d.max,
    conocidos: lista.filter((p) => p.ciudad === city.city).map((p) => p.waId),
  });
  const hallazgos = await d.claude(prompt);

  const descartes: Record<string, number> = {};
  const skip = (why: string) => { descartes[why] = (descartes[why] ?? 0) + 1; };
  let guardados = 0;
  for (const h of hallazgos) {
    if (guardados >= d.max) break;
    if (looksLikeTeam(h.nombre)) { skip('equipo'); continue; }
    const waId = toWaId(h.celular);
    if (!waId) { skip('sin_telefono'); continue; }
    if (isBlacklisted(h.pagina)) { skip('red_social'); continue; }
    if (bajas.has(waId)) { skip('baja'); continue; }
    if (conocidos.has(waId)) { skip('duplicado'); continue; }
    let texto: string;
    try {
      texto = await d.fetchPage(h.pagina);
    } catch {
      skip('no_en_pagina');
      continue;
    }
    if (!phoneInText(texto, h.celular)) { skip('no_en_pagina'); continue; }
    conocidos.add(waId);
    lista.push({
      nombre: h.nombre, celular: h.celular, waId, ...(h.email ? { email: h.email } : {}),
      ciudad: city.city, provincia: city.province, pagina: h.pagina, encontradoEl: d.now.toISOString(),
    });
    guardados++;
  }

  if (guardados || borradosPorBaja) writeJsonAtomic(file(PROSPECTOS_FILE), lista);
  writeJsonAtomic(file(ESTADO_FILE), { ciudad: (idx + 1) % CITIES.length });
  const result: CorridaResult = { ciudad: city.city, hallados: hallazgos.length, guardados, descartes, borradosPorBaja, at: d.now.toISOString() };
  const corridas = readJson<CorridaResult[]>(file(CORRIDAS_FILE), []);
  writeJsonAtomic(file(CORRIDAS_FILE), [...(Array.isArray(corridas) ? corridas : []), result].slice(-MAX_CORRIDAS));
  return result;
}
