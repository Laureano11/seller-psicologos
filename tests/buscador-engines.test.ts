import { describe, it, expect } from 'vitest';
import { ENGINES, isBlacklisted } from '../src/agents/buscador/engines.js';
import { createRobotsChecker } from '../src/agents/buscador/robots.js';
import type { PageSnapshot } from '../src/agents/buscador/browser.js';

const snap = (url: string, hrefs: string[], text = ''): PageSnapshot => ({ url, text, links: hrefs.map((href) => ({ href, text: '' })) });

describe('google', () => {
  const g = ENGINES.google;
  it('google searchUrl', () => {
    expect(g.searchUrl('psicólogo Rosario', 2)).toBe('https://www.google.com/search?q=psic%C3%B3logo%20Rosario&hl=es-419&gl=ar&start=10');
    expect(g.searchUrl('x', 1)).toBe('https://www.google.com/search?q=x&hl=es-419&gl=ar&start=0');
  });
  it('google parseResults: descarta google, desarma /url?q= y quita repetidos', () => {
    const s = snap('https://www.google.com/search?q=x', [
      'https://www.google.com/search?q=otra',
      'https://maps.google.com/x',
      'https://accounts.google.com/login',
      'https://webcache.googleusercontent.com/search?q=cache:a',
      'https://www.google.com/url?q=https://ana-psicologa.com/contacto&sa=U',
      'https://ana-psicologa.com/contacto',
      'https://listado.com.ar/psicologos#top',
      'mailto:x@y.com',
    ]);
    expect(g.parseResults(s)).toEqual(['https://ana-psicologa.com/contacto', 'https://listado.com.ar/psicologos']);
  });
  it('google isBlocked', () => {
    expect(g.isBlocked(snap('https://www.google.com/sorry/index?continue=x', []))).toBe(true);
    expect(g.isBlocked(snap('https://www.google.com/search?q=x', [], 'Nuestros sistemas detectaron tráfico inusual'))).toBe(true);
    expect(g.isBlocked(snap('https://www.google.com/search?q=x', [], 'Our systems have detected unusual traffic'))).toBe(true);
    expect(g.isBlocked(snap('https://www.google.com/search?q=x', [], 'Resultados'))).toBe(false);
  });
});

describe('duckduckgo', () => {
  const d = ENGINES.duckduckgo;
  it('duckduckgo searchUrl', () => {
    expect(d.searchUrl('psicólogo Rosario', 1)).toBe('https://html.duckduckgo.com/html/?q=psic%C3%B3logo%20Rosario');
    expect(d.searchUrl('x', 3)).toBe('https://html.duckduckgo.com/html/?q=x&s=60');
  });
  it('duckduckgo parseResults decodifica uddg', () => {
    const s = snap('https://html.duckduckgo.com/html/?q=x', [
      'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fana.com%2F&rut=abc',
      'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fana.com%2F&rut=def',
      'https://html.duckduckgo.com/html/?q=x&s=30',
      'https://duckduckgo.com/y.js?ad=1',
      'https://directo.com/p',
    ]);
    expect(d.parseResults(s)).toEqual(['https://ana.com/', 'https://directo.com/p']);
  });
});

describe('bing', () => {
  const b = ENGINES.bing;
  const enc = (u: string) => 'a1' + Buffer.from(u).toString('base64url');
  it('bing searchUrl', () => {
    expect(b.searchUrl('psicóloga Rosario', 1)).toBe('https://www.bing.com/search?q=psic%C3%B3loga%20Rosario&setlang=es&cc=AR&first=1');
    expect(b.searchUrl('x', 3)).toBe('https://www.bing.com/search?q=x&setlang=es&cc=AR&first=21');
  });
  it('bing parseResults decodifica /ck/a?u=a1<base64url> y descarta links de bing/microsoft', () => {
    const s = snap('https://www.bing.com/search?q=x', [
      `https://www.bing.com/ck/a?!&&p=abc&u=${enc('https://www.doctoralia.com.ar/psicologo/rosario')}&ntb=1`,
      `https://www.bing.com/ck/a?!&&p=def&u=${enc('https://www.doctoralia.com.ar/psicologo/rosario')}&ntb=1`,
      'https://www.bing.com/search?q=otra',
      'https://go.microsoft.com/fwlink/?LinkId=521839',
      'https://www.msn.com/es-ar',
      'https://ana-psicologa.com/',
    ]);
    expect(b.parseResults(s)).toEqual(['https://www.doctoralia.com.ar/psicologo/rosario', 'https://ana-psicologa.com/']);
  });
  it('si el navegador trajo los resultados orgánicos, usa solo esos (ignora carruseles y noticias)', () => {
    const s: PageSnapshot = {
      ...snap('https://www.bing.com/search?q=x', ['https://www.tycsports.com/futbol']),
      results: [`https://www.bing.com/ck/a?!&&p=1&u=${enc('https://psicorosario.com/')}`, 'https://directo.com/p'],
    };
    expect(b.parseResults(s)).toEqual(['https://psicorosario.com/', 'https://directo.com/p']);
  });
  it('cada motor declara el selector de sus resultados orgánicos', () => {
    expect(ENGINES.bing.resultSelector).toBe('li.b_algo h2 a');
    expect(ENGINES.google.resultSelector).toBe('#search a:has(h3)');
    expect(ENGINES.duckduckgo.resultSelector).toBe('a.result__a');
  });
  it('bing isBlocked', () => {
    expect(b.isBlocked(snap('https://www.bing.com/search?q=x', [], 'Resolvé el captcha para continuar'))).toBe(true);
    expect(b.isBlocked(snap('https://www.bing.com/search?q=x', [], 'Psicólogos en Rosario: 144 profesionales'))).toBe(false);
  });
});

describe('duckduckgo bloqueo', () => {
  it('detecta el desafío anti-bots', () => {
    expect(ENGINES.duckduckgo.isBlocked(snap('https://html.duckduckgo.com/html/?q=x', [], 'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge'))).toBe(true);
  });
});

describe('lista negra', () => {
  it('isBlacklisted', () => {
    expect(isBlacklisted('https://ar.linkedin.com/in/x')).toBe(true);
    expect(isBlacklisted('https://www.instagram.com/ana')).toBe(true);
    expect(isBlacklisted('https://m.facebook.com/ana')).toBe(true);
    expect(isBlacklisted('https://x.com/ana')).toBe(true);
    expect(isBlacklisted('https://ana-psicologa.com')).toBe(false);
    expect(isBlacklisted('https://box.com')).toBe(false);
    expect(isBlacklisted('no es url')).toBe(true);
  });
});

describe('robots', () => {
  const fetchOf = (body: string | null, calls: string[] = []) =>
    (async (url: string) => {
      calls.push(url);
      return body === null ? new Response('', { status: 404 }) : new Response(body);
    }) as unknown as typeof fetch;
  it('robots: Disallow bajo User-agent *', async () => {
    const r = createRobotsChecker(fetchOf('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /privado\nAllow: /privado/publico\n'));
    expect(await r.allowed('https://a.com/privado/x')).toBe(false);
    expect(await r.allowed('https://a.com/privado/publico/y')).toBe(true);
    expect(await r.allowed('https://a.com/otra')).toBe(true);
  });
  it('robots: 404 o error de red -> permitido', async () => {
    expect(await createRobotsChecker(fetchOf(null)).allowed('https://a.com/x')).toBe(true);
    const boom = (async () => { throw new Error('red'); }) as unknown as typeof fetch;
    expect(await createRobotsChecker(boom).allowed('https://a.com/x')).toBe(true);
  });
  it('robots: un fetch por dominio', async () => {
    const calls: string[] = [];
    const r = createRobotsChecker(fetchOf('User-agent: *\nDisallow:\n', calls));
    await r.allowed('https://a.com/1');
    await r.allowed('https://a.com/2');
    await r.allowed('https://b.com/1');
    expect(calls).toEqual(['https://a.com/robots.txt', 'https://b.com/robots.txt']);
  });
});
