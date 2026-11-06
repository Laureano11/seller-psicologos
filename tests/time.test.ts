import { describe, it, expect } from 'vitest';
import { parseWindow, isInWindow, nextSendTime } from '../src/time.js';

const tz = 'America/Argentina/Buenos_Aires';
const w = parseWindow('mon-fri 09:00-20:00');

describe('time', () => {
  it('parseWindow', () => {
    expect(w).toEqual({ days: [1, 2, 3, 4, 5], start: '09:00', end: '20:00' });
    expect(parseWindow('mon,wed 10:00-12:00').days).toEqual([1, 3]);
    expect(() => parseWindow('algo raro')).toThrow();
  });
  it('isInWindow', () => {
    expect(isInWindow(new Date('2026-11-09T13:00:00-03:00'), w, tz)).toBe(true);
    expect(isInWindow(new Date('2026-11-08T13:00:00-03:00'), w, tz)).toBe(false);
    expect(isInWindow(new Date('2026-11-09T20:00:00-03:00'), w, tz)).toBe(false);
    expect(isInWindow(new Date('2026-11-09T08:59:00-03:00'), w, tz)).toBe(false);
  });
  it('nextSendTime', () => {
    const inside = new Date('2026-11-09T13:00:00-03:00');
    expect(nextSendTime(inside, w, tz).toISOString()).toBe(inside.toISOString());
    expect(nextSendTime(new Date('2026-11-06T21:30:00-03:00'), w, tz).toISOString()).toBe(
      new Date('2026-11-09T09:00:00-03:00').toISOString(),
    );
    expect(nextSendTime(new Date('2026-11-09T07:00:00-03:00'), w, tz).toISOString()).toBe(
      new Date('2026-11-09T09:00:00-03:00').toISOString(),
    );
  });
});
