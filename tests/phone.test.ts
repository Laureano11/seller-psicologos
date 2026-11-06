import { describe, it, expect } from 'vitest';
import { toWaId } from '../src/phone.js';

describe('toWaId', () => {
  it('normaliza formatos argentinos', () => {
    expect(toWaId('+54 9 11 2345-6789')).toBe('5491123456789');
    expect(toWaId('011 15 2345-6789')).toBe('5491123456789');
    expect(toWaId('(0351) 15 555-1234')).toBe('5493515551234');
    expect(toWaId('11 2345-6789')).toBe('5491123456789');
  });
  it('devuelve null para basura', () => {
    expect(toWaId('hola')).toBeNull();
    expect(toWaId('')).toBeNull();
    expect(toWaId('123')).toBeNull();
  });
  it('acepta números internacionales válidos', () => {
    expect(toWaId('+1 415 555 2671')).toBe('14155552671');
  });
});
