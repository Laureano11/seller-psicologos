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
