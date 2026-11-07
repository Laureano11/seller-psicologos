import type { PageSnapshot } from './browser.js';

export type EngineName = 'google' | 'duckduckgo';

export interface SearchEngine {
  name: EngineName;
  /** URL de la página de resultados; page empieza en 1. */
  searchUrl(query: string, page: number): string;
  /** URLs orgánicas, sin repetir, en orden. */
  parseResults(s: PageSnapshot): string[];
  /** CAPTCHA o página de "tráfico inusual". */
  isBlocked(s: PageSnapshot): boolean;
}

/** Dominios que el Buscador nunca abre (redes sociales; LinkedIn descartado por decisión de Lauri). */
export const BLACKLIST = ['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'youtube.com'];

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

const matchesDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function isBlacklisted(url: string): boolean {
  const host = hostOf(url);
  return !host || BLACKLIST.some((d) => matchesDomain(host, d));
}

/** Quita el #fragmento y deja solo URLs http(s) no repetidas, en orden. */
function uniqueHttp(urls: (string | null)[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    if (!raw || !hostOf(raw)) continue;
    const u = new URL(raw);
    u.hash = '';
    const s = u.toString();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const isGoogleHost = (host: string) => /(^|\.)google\.[a-z.]+$/.test(host) || host.endsWith('googleusercontent.com');

const google: SearchEngine = {
  name: 'google',
  searchUrl: (q, page) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=es-419&gl=ar&start=${(page - 1) * 10}`,
  parseResults(s) {
    return uniqueHttp(
      s.links.map(({ href }) => {
        const host = hostOf(href);
        if (!host) return null;
        if (isGoogleHost(host)) {
          const u = new URL(href);
          return u.pathname === '/url' ? u.searchParams.get('q') ?? u.searchParams.get('url') : null;
        }
        return href;
      }),
    );
  },
  isBlocked: (s) => s.url.includes('/sorry/') || /tráfico inusual|unusual traffic/i.test(s.text),
};

const duckduckgo: SearchEngine = {
  name: 'duckduckgo',
  searchUrl: (q, page) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${page > 1 ? `&s=${(page - 1) * 30}` : ''}`,
  parseResults(s) {
    return uniqueHttp(
      s.links.map(({ href }) => {
        const host = hostOf(href);
        if (!host) return null;
        if (matchesDomain(host, 'duckduckgo.com')) {
          const u = new URL(href);
          return u.pathname === '/l/' ? u.searchParams.get('uddg') : null;
        }
        return href;
      }),
    );
  },
  isBlocked: (s) => /anomaly|unusual traffic|tráfico inusual|captcha/i.test(s.text),
};

export const ENGINES: Record<EngineName, SearchEngine> = { google, duckduckgo };
