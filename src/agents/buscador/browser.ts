/** Navegador del Buscador: Chromium headless con un perfil propio (nunca el Chrome personal de Lauri). */

export type PageSnapshot = {
  url: string;
  text: string;
  links: { href: string; text: string }[];
  /** Solo en páginas de buscador: href de los resultados orgánicos (según el selector del motor). */
  results?: string[];
};

export type OpenOptions = { resultSelector?: string };

export interface Browser {
  /** Abre la URL y devuelve texto visible + links. Lanza si no carga en 15 s o responde >= 400. */
  open(url: string, opts?: OpenOptions): Promise<PageSnapshot>;
  close(): Promise<void>;
}

const PAGE_TIMEOUT_MS = 15_000;

/** La página respondió con un estado HTTP de error (403/429 en un buscador = bloqueo). */
export class HttpStatusError extends Error {
  constructor(public status: number, url: string) {
    super(`HTTP ${status} en ${url}`);
    this.name = 'HttpStatusError';
  }
}

export async function launchBrowser(o: { profileDir: string; tz: string }): Promise<Browser> {
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext(o.profileDir, {
    headless: true,
    channel: 'chromium', // headless nuevo (Chromium completo), en vez del headless-shell
    locale: 'es-AR',
    timezoneId: o.tz,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return {
    async open(url, opts) {
      const res = await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      if (res && res.status() >= 400) throw new HttpStatusError(res.status(), url);
      const data = await page.evaluate(() => ({
        text: document.body?.innerText ?? '',
        links: Array.from(document.querySelectorAll('a[href]')).map((a) => ({
          href: (a as HTMLAnchorElement).href,
          text: ((a as HTMLAnchorElement).innerText ?? '').trim(),
        })),
      }));
      const snap: PageSnapshot = { url: page.url(), ...data };
      if (opts?.resultSelector) {
        snap.results = await page.$$eval(opts.resultSelector, (as) => as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean));
      }
      return snap;
    },
    async close() {
      await ctx.close().catch(() => undefined);
    },
  };
}

/** Navegador falso para pruebas: devuelve los snapshots dados; un Error o una URL desconocida lanza. */
export function createFakeBrowser(pages: Record<string, PageSnapshot | Error>): Browser & { opened: string[]; closed: boolean } {
  const b = {
    opened: [] as string[],
    closed: false,
    async open(url: string): Promise<PageSnapshot> {
      b.opened.push(url);
      const p = pages[url];
      if (!p) throw new Error(`página desconocida: ${url}`);
      if (p instanceof Error) throw p;
      return p;
    },
    async close() {
      b.closed = true;
    },
  };
  return b;
}
