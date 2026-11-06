import { readFileSync, statSync } from 'node:fs';
import type { Config } from './config.js';
import { toWaId } from './phone.js';

export interface DncChecker {
  isBlocked(waId: string): Promise<boolean>;
}

/** `file`: CSV/TXT con números (cualquier formato; se recarga si el archivo cambia). `off`: nunca bloquea. */
export function createDncChecker(config: Pick<Config, 'dncMode' | 'dncFile'>): DncChecker {
  if (config.dncMode === 'off') return { isBlocked: async () => false };
  const file = config.dncFile;
  if (!file) throw new Error('DNC_MODE=file requiere DNC_FILE');
  let cached: { mtime: number; ids: Set<string> } | undefined;
  return {
    async isBlocked(waId) {
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
