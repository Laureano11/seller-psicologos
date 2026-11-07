import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://x', OWNER_WA_ID: '5491155551234', HUB_PASSWORD: 'una-clave-larga', DNC_MODE: 'off' };

describe('loadConfig', () => {
  it('defaults', () => {
    const c = loadConfig(base);
    expect(c.dailyNewContacts).toBe(5);
    expect(c.searchHour).toBe(9);
    expect(c.tz).toBe('America/Argentina/Buenos_Aires');
    expect(c.sendWindow.days).toEqual([1, 2, 3, 4, 5]);
    expect(c.meetingWindow.start).toBe('10:00');
    expect(c.followupDays).toBe(3);
    expect(c.closeAfterDays).toBe(4);
    expect(c.maxFollowups).toBe(1);
    expect(c.ownerName).toBe('Lauri');
    expect(c.replyDebounceSeconds).toBe(30);
    expect(c.google).toBeUndefined();
  });
  it('DNC_MODE=file sin DNC_FILE falla; por defecto es file', () => {
    expect(() => loadConfig({ ...base, DNC_MODE: 'file' })).toThrow(/DNC_FILE/);
    const { DNC_MODE: _omit, ...noMode } = base;
    expect(() => loadConfig(noMode)).toThrow(/DNC_FILE/);
    expect(loadConfig({ ...base, DNC_MODE: 'file', DNC_FILE: 'x.csv' }).dncFile).toBe('x.csv');
  });
  it('faltantes obligatorios', () => {
    for (const k of ['DATABASE_URL', 'OWNER_WA_ID']) {
      expect(() => loadConfig({ ...base, [k]: undefined })).toThrow(k);
    }
  });
  it('llm y google', () => {
    const c = loadConfig({
      ...base,
      LLM_VENDEDOR: 'google:a, groq:b',
      GOOGLE_CLIENT_ID: 'i',
      GOOGLE_CLIENT_SECRET: 's',
      GOOGLE_REFRESH_TOKEN: 'r',
    });
    expect(c.llm.vendedor).toEqual(['google:a', 'groq:b']);
    expect(c.llm.buscador).toEqual([]);
    expect(c.google).toEqual({ clientId: 'i', clientSecret: 's', refreshToken: 'r', calendarId: 'primary' });
  });
  it('rechaza contraseña del hub débil o de ejemplo', () => {
    for (const pw of ['cambiame', 'corta', '123456789']) {
      expect(() => loadConfig({ ...base, HUB_PASSWORD: pw })).toThrow(/HUB_PASSWORD/);
    }
    expect(loadConfig({ ...base, HUB_PASSWORD: '1234567890' }).hubPassword).toBe('1234567890');
  });
  it('HUB_PASSWORD vacía o ausente = hub sin contraseña', () => {
    expect(loadConfig({ ...base, HUB_PASSWORD: undefined }).hubPassword).toBe('');
    expect(loadConfig({ ...base, HUB_PASSWORD: '' }).hubPassword).toBe('');
  });
  it('rechaza OWNER_WA_ID inválido o de ejemplo', () => {
    for (const id of ['5491100000000', '123456789', '5491155551234567', '+5491155551234', '54 9 11 5555 1234']) {
      expect(() => loadConfig({ ...base, OWNER_WA_ID: id })).toThrow(/OWNER_WA_ID/);
    }
    expect(loadConfig({ ...base, OWNER_WA_ID: '5490000000001' }).ownerWaId).toBe('5490000000001');
    expect(loadConfig({ ...base, OWNER_WA_ID: '1234567890' }).ownerWaId).toBe('1234567890');
  });
});

describe('loadConfig: buscador', () => {
  it('buscador: defaults', () => {
    expect(loadConfig(base).buscador).toEqual({
      maxSearches: 25, maxPages: 150, resultsPerQuery: 10, maxWaChecks: 150,
      searchDelayMs: [20000, 60000], pageDelayMs: [3000, 8000], engine: 'bing', profileDir: 'browser_profile',
    });
  });
  it('buscador: rango "5-10" -> [5000, 10000]', () => {
    expect(loadConfig({ ...base, BUSCADOR_SEARCH_DELAY: '5-10' }).buscador.searchDelayMs).toEqual([5000, 10000]);
    expect(loadConfig({ ...base, BUSCADOR_PAGE_DELAY: ' 0-2 ' }).buscador.pageDelayMs).toEqual([0, 2000]);
  });
  it('buscador: rango inválido lanza nombrando la variable', () => {
    expect(() => loadConfig({ ...base, BUSCADOR_SEARCH_DELAY: '10-5' })).toThrow(/BUSCADOR_SEARCH_DELAY/);
    expect(() => loadConfig({ ...base, BUSCADOR_PAGE_DELAY: 'abc' })).toThrow(/BUSCADOR_PAGE_DELAY/);
  });
  it('buscador: BUSCADOR_ENGINE inválido lanza', () => {
    expect(() => loadConfig({ ...base, BUSCADOR_ENGINE: 'yahoo' })).toThrow(/BUSCADOR_ENGINE/);
    expect(loadConfig({ ...base, BUSCADOR_ENGINE: 'google' }).buscador.engine).toBe('google');
    expect(loadConfig({ ...base, BUSCADOR_ENGINE: 'duckduckgo' }).buscador.engine).toBe('duckduckgo');
  });
});
