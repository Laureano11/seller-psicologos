import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Un psicólogo encontrado por el Buscador, tal como queda en data/prospectos.json. */
export type Psicologo = {
  nombre: string;
  celular: string;
  waId: string;
  email?: string;
  ciudad: string;
  provincia: string;
  pagina: string;
  encontradoEl: string;
};

/** Lo escribe solo la corrida de la Mac. */
export const PROSPECTOS_FILE = 'prospectos.json';
/** Lo escribe solo el worker: números dados de baja, que la Mac borra del .json. */
export const BAJAS_FILE = 'bajas.json';
/** Ciudad por la que sigue la próxima corrida. */
export const ESTADO_FILE = 'buscador-estado.json';
/** Resumen de las últimas corridas (para el hub). */
export const CORRIDAS_FILE = 'buscador-corridas.json';

/** Lee un JSON; si no existe o está roto devuelve `fallback`. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Escribe en un temporal y lo renombra: quien lee nunca ve un archivo a medias. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}
