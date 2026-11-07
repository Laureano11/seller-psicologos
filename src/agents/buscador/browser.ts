/** Navegador del Buscador: Chromium headless con un perfil propio (nunca el Chrome personal de Lauri). */

export type PageSnapshot = { url: string; text: string; links: { href: string; text: string }[] };

export interface Browser {
  /** Abre la URL y devuelve texto visible + links. Lanza si no carga en 15 s o responde >= 400. */
  open(url: string): Promise<PageSnapshot>;
  close(): Promise<void>;
}

const PAGE_TIMEOUT_MS = 15_000;

export async function launchBrowser(o: { profileDir: string; tz: string }): Promise<Browser> {
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext(o.profileDir, {
    headless: true,
    locale: 'es-AR',
    timezoneId: o.tz,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return {
    async open(url) {
      const res = await page.goto(url, { timeout: PAGE_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
      if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()} en ${url}`);
      const data = await page.evaluate(() => ({
        text: document.body?.innerText ?? '',
        links: Array.from(document.querySelectorAll('a[href]')).map((a) => ({
          href: (a as HTMLAnchorElement).href,
          text: ((a as HTMLAnchorElement).innerText ?? '').trim(),
        })),
      }));
      return { url: page.url(), ...data };
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
