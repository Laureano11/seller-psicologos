import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDncChecker, reportDncStatus } from '../src/dnc.js';
import { createMemoryDb, migrate } from '../src/db/db.js';
import * as repo from '../src/db/repo.js';
import { runBuscador } from '../src/agents/buscador/run.js';
import { createFakeLlm } from '../src/llm/llm.js';
import { createFakeTransport } from '../src/whatsapp/transport.js';
import { loadConfig } from '../src/config.js';

const env = { DATABASE_URL: 'x', OWNER_WA_ID: '5491155551234', HUB_PASSWORD: 'una-clave-larga' };

describe('dnc', () => {
  it('file bloquea números listados', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnc-'));
    const f = join(dir, 'dnc.csv');
    writeFileSync(f, 'telefono\n11 2345-6789\n"0351 15 555-1234",otro\n');
    const c = createDncChecker(loadConfig({ ...env, DNC_MODE: 'file', DNC_FILE: f }));
    expect(await c.isBlocked('5491123456789')).toBe(true);
    expect(await c.isBlocked('5493515551234')).toBe(true);
    expect(await c.isBlocked('5491100000001')).toBe(false);
    writeFileSync(f, '11 9999-0000\n');
    expect(await c.isBlocked('5491123456789')).toBe(false);
    expect(await c.isBlocked('5491199990000')).toBe(true);
  });
  it('off nunca bloquea', async () => {
    const c = createDncChecker(loadConfig({ ...env, DNC_MODE: 'off' }));
    expect(await c.isBlocked('5491123456789')).toBe(false);
  });
  it('archivo faltante: no lanza, bloquea todo, avisa (evento + kv) y el buscador no agrega nada', async () => {
    const f = join(mkdtempSync(join(tmpdir(), 'dnc-')), 'no-existe.csv');
    const c = createDncChecker(loadConfig({ ...env, DNC_MODE: 'file', DNC_FILE: f }));
    expect(c.missingFile?.()).toBe(f);
    expect(await c.isBlocked('5491123456789')).toBe(true);
    const db = await createMemoryDb();
    try {
      await migrate(db);
      expect(await reportDncStatus(db, c)).toBe(false);
      expect(await repo.kvGet(db, 'dnc_error')).toEqual({ archivo: f });
      expect((await repo.listEvents(db, 5)).map((e) => e.type)).toContain('dnc_archivo_faltante');
      let searched = 0;
      const wa = createFakeTransport();
      wa.whatsappNumbers.add('5491111111111');
      const r = await runBuscador({
        db, dnc: c, wa, config: { buscadorMaxPerDay: 50, buscador: loadConfig({ DATABASE_URL: 'x', OWNER_WA_ID: '5491155551234', DNC_MODE: 'off' }).buscador },
        engines: [], robots: { allowed: async () => true }, notifyOwner: async () => undefined, contentDir: 'content',
        llm: createFakeLlm(() => { throw new Error('no debería llamarse'); }),
        sources: [{ name: 'fake', search: async () => { searched++; return [{ name: 'X', phone: '11 1111-1111', city: 'CABA', province: 'CABA', source: 'fake', sourceRef: 'x' }]; } }],
      }, new Date());
      expect(r.inserted).toBe(0);
      expect(r.skipped).toEqual({ no_llame_sin_archivo: 1 });
      expect(searched).toBe(0);
      expect(await db.query('SELECT 1 FROM prospects')).toHaveLength(0);
      // al aparecer el archivo, se limpia el error
      writeFileSync(f, '11 9999-0000\n');
      expect(await reportDncStatus(db, c)).toBe(true);
      expect(await repo.kvGet(db, 'dnc_error')).toBeNull();
    } finally {
      await db.close();
    }
  });
});
