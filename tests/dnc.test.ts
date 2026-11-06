import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDncChecker } from '../src/dnc.js';
import { loadConfig } from '../src/config.js';

const env = { DATABASE_URL: 'x', OWNER_WA_ID: '5491100000000', HUB_PASSWORD: 'p' };

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
});
