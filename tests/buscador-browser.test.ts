import { describe, it, expect } from 'vitest';
import { createFakeBrowser, type PageSnapshot } from '../src/agents/buscador/browser.js';

const snap = (url: string): PageSnapshot => ({ url, text: 'hola', links: [{ href: 'tel:+5491111111111', text: 'llamar' }] });

describe('fake browser', () => {
  it('fake browser: devuelve snapshot, registra opened y lanza para Error o URL desconocida', async () => {
    const b = createFakeBrowser({ 'https://a.com': snap('https://a.com/final'), 'https://b.com': new Error('timeout') });
    expect(await b.open('https://a.com')).toEqual(snap('https://a.com/final'));
    await expect(b.open('https://b.com')).rejects.toThrow('timeout');
    await expect(b.open('https://c.com')).rejects.toThrow();
    expect(b.opened).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    await b.close();
  });
});
