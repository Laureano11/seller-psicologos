import type { PageSnapshot } from './browser.js';

export type EngineName = 'bing' | 'google' | 'duckduckgo';

export interface SearchEngine {
  name: EngineName;
  /** CSS de los links de resultados orgánicos (sin anuncios, noticias ni carruseles). */
  resultSelector: string;
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

/** Links candidatos: los resultados orgánicos si el navegador los trajo; si no, todos los links. */
const candidates = (s: PageSnapshot): string[] => s.results ?? s.links.map((l) => l.href);

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
  resultSelector: '#search a:has(h3)',
  searchUrl: (q, page) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=es-419&gl=ar&start=${(page - 1) * 10}`,
  parseResults(s) {
    return uniqueHttp(
      candidates(s).map((href) => {
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
  resultSelector: 'a.result__a',
  searchUrl: (q, page) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${page > 1 ? `&s=${(page - 1) * 30}` : ''}`,
  parseResults(s) {
    return uniqueHttp(
      candidates(s).map((href) => {
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
  isBlocked: (s) => /anomaly|unusual traffic|tráfico inusual|captcha|bots use duckduckgo|complete the following challenge/i.test(s.text),
};

const isMicrosoftHost = (host: string) => ['bing.com', 'microsoft.com', 'msn.com', 'live.com'].some((d) => matchesDomain(host, d));

/** Bing envuelve los resultados en /ck/a?...&u=a1<URL en base64url>. */
function decodeBingRedirect(href: string): string | null {
  const u = new URL(href).searchParams.get('u');
  if (!u?.startsWith('a1')) return null;
  try {
    return Buffer.from(u.slice(2), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

const bing: SearchEngine = {
  name: 'bing',
  resultSelector: 'li.b_algo h2 a',
  searchUrl: (q, page) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=es&cc=AR&first=${(page - 1) * 10 + 1}`,
  parseResults(s) {
    return uniqueHttp(
      candidates(s).map((href) => {
        const host = hostOf(href);
        if (!host) return null;
        if (isMicrosoftHost(host)) return new URL(href).pathname === '/ck/a' ? decodeBingRedirect(href) : null;
        return href;
      }),
    );
  },
  isBlocked: (s) => /captcha|unusual traffic|tráfico inusual|verify you are a human|demuestra que eres humano/i.test(s.text),
};

export const ENGINES: Record<EngineName, SearchEngine> = { bing, google, duckduckgo };

/** Motor principal primero; el resto queda de respaldo ante bloqueos. */
export function engineOrder(primary: EngineName): SearchEngine[] {
  return [ENGINES[primary], ...(Object.keys(ENGINES) as EngineName[]).filter((n) => n !== primary).map((n) => ENGINES[n])];
}
