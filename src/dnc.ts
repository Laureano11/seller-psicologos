import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { kvSet, logEvent } from './db/repo.js';
import { toWaId } from './phone.js';

export interface DncChecker {
  isBlocked(waId: string): Promise<boolean>;
  /** Ruta del archivo No Llame si DNC_MODE=file y no existe; null si está todo bien. */
  missingFile?(): string | null;
}

/**
 * `file`: CSV/TXT con números (cualquier formato; se recarga si el archivo cambia). `off`: nunca bloquea.
 * Si falta el archivo no se cae: bloquea todo (no se contacta a nadie sin poder chequear el registro).
 */
export function createDncChecker(config: Pick<Config, 'dncMode' | 'dncFile'>): DncChecker {
  if (config.dncMode === 'off') return { isBlocked: async () => false, missingFile: () => null };
  const file = config.dncFile;
  if (!file) throw new Error('DNC_MODE=file requiere DNC_FILE');
  let cached: { mtime: number; ids: Set<string> } | undefined;
  return {
    missingFile: () => (existsSync(file) ? null : file),
    async isBlocked(waId) {
      if (!existsSync(file)) return true;
      const mtime = statSync(file).mtimeMs;
      if (!cached || cached.mtime !== mtime) {
        const ids = new Set<string>();
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
          for (const cell of line.split(/[,;\t]/)) {
            const id = toWaId(cell.replace(/["']/g, ''));
            if (id) ids.add(id);
          }
        }
        cached = { mtime, ids };
      }
      return cached.ids.has(waId);
    },
  };
}

/** Registra el estado del archivo No Llame: evento `dnc_archivo_faltante` + kv `dnc_error` (banner del hub). Devuelve true si está ok. */
export async function reportDncStatus(db: Db, dnc: DncChecker): Promise<boolean> {
  const missing = dnc.missingFile?.() ?? null;
  if (missing) {
    await logEvent(db, 'dnc_archivo_faltante', { archivo: missing });
    await kvSet(db, 'dnc_error', { archivo: missing });
    return false;
  }
  await kvSet(db, 'dnc_error', null);
  return true;
}
