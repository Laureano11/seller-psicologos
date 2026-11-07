import { parseWindow, type Window } from './time.js';

export type Config = {
  databaseUrl: string;
  tz: string;
  dailyNewContacts: number;
  sendWindow: Window;
  meetingWindow: Window;
  meetingMinutes: number;
  searchHour: number;
  buscadorMaxPerDay: number;
  buscador: {
    maxSearches: number;
    maxPages: number;
    resultsPerQuery: number;
    maxWaChecks: number;
    searchDelayMs: [number, number];
    pageDelayMs: [number, number];
    engine: 'google' | 'duckduckgo';
    profileDir: string;
  };
  followupDays: number;
  closeAfterDays: number;
  maxFollowups: number;
  abMinPerVariant: number;
  ownerWaId: string;
  ownerName: string;
  dncMode: 'file' | 'off';
  dncFile?: string;
  llm: { buscador: string[]; vendedor: string[]; analista: string[] };
  googlePlacesKey?: string;
  google?: { clientId: string; clientSecret: string; refreshToken: string; calendarId: string };
  hubUser: string;
  hubPassword: string;
  contentDir: string;
  waAuthDir: string;
  replyDebounceSeconds: number;
};

type Env = Record<string, string | undefined>;

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: Env): Config {
  const req = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`Falta la variable de entorno ${k}`);
    return v;
  };
  const num = (k: string, def: number): number => {
    const v = env[k]?.trim();
    if (!v) return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${k} debe ser numérico (recibido "${v}")`);
    return n;
  };

  /** Rango en segundos "a-b" -> [ms, ms], con 0 <= a <= b. */
  const range = (k: string, def: [number, number]): [number, number] => {
    const v = env[k]?.trim();
    if (!v) return [def[0] * 1000, def[1] * 1000];
    const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(v);
    const a = m ? Number(m[1]) : NaN;
    const b = m ? Number(m[2]) : NaN;
    if (!m || a > b) throw new Error(`${k} debe ser un rango en segundos "min-max" (recibido "${v}")`);
    return [a * 1000, b * 1000];
  };

  const engine = env.BUSCADOR_ENGINE?.trim() || 'google';
  if (engine !== 'google' && engine !== 'duckduckgo') {
    throw new Error(`BUSCADOR_ENGINE debe ser "google" o "duckduckgo" (recibido "${engine}")`);
  }

  const dncMode = (env.DNC_MODE?.trim() || 'file') as string;
  if (dncMode !== 'file' && dncMode !== 'off') throw new Error(`DNC_MODE debe ser "file" u "off" (recibido "${dncMode}")`);
  const dncFile = env.DNC_FILE?.trim() || undefined;
  if (dncMode === 'file' && !dncFile) throw new Error('DNC_MODE=file requiere DNC_FILE');

  const ownerWaId = req('OWNER_WA_ID');
  if (!/^\d{10,15}$/.test(ownerWaId) || ownerWaId === '5491100000000') {
    throw new Error('OWNER_WA_ID debe ser tu número real de WhatsApp: 10 a 15 dígitos, formato internacional sin + (ej. 5491123456789)');
  }
  // Opcional: vacía = hub sin contraseña (solo para uso local). Si se define, debe ser fuerte.
  const hubPassword = env.HUB_PASSWORD?.trim() ?? '';
  if (hubPassword && (hubPassword.length < 10 || hubPassword === 'cambiame')) {
    throw new Error('HUB_PASSWORD debe tener al menos 10 caracteres y no ser la de ejemplo');
  }

  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN
      ? {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          refreshToken: env.GOOGLE_REFRESH_TOKEN,
          calendarId: env.GOOGLE_CALENDAR_ID?.trim() || 'primary',
        }
      : undefined;

  return {
    databaseUrl: req('DATABASE_URL'),
    tz: env.TZ?.trim() || 'America/Argentina/Buenos_Aires',
    dailyNewContacts: num('DAILY_NEW_CONTACTS', 5),
    sendWindow: parseWindow(env.SEND_WINDOW?.trim() || 'mon-fri 09:00-20:00'),
    meetingWindow: parseWindow(env.MEETING_WINDOW?.trim() || 'mon-fri 10:00-18:00'),
    meetingMinutes: num('MEETING_MINUTES', 30),
    searchHour: num('SEARCH_HOUR', 9),
    buscadorMaxPerDay: num('BUSCADOR_MAX_PER_DAY', 50),
    buscador: {
      maxSearches: num('BUSCADOR_MAX_SEARCHES', 25),
      maxPages: num('BUSCADOR_MAX_PAGES', 150),
      resultsPerQuery: num('BUSCADOR_RESULTS_PER_QUERY', 10),
      maxWaChecks: num('BUSCADOR_MAX_WA_CHECKS', 150),
      searchDelayMs: range('BUSCADOR_SEARCH_DELAY', [20, 60]),
      pageDelayMs: range('BUSCADOR_PAGE_DELAY', [3, 8]),
      engine,
      profileDir: env.BUSCADOR_PROFILE_DIR?.trim() || 'browser_profile',
    },
    followupDays: num('FOLLOWUP_DAYS', 3),
    closeAfterDays: num('CLOSE_AFTER_DAYS', 4),
    maxFollowups: num('MAX_FOLLOWUPS', 1),
    abMinPerVariant: num('AB_MIN_PER_VARIANT', 30),
    ownerWaId,
    ownerName: env.OWNER_NAME?.trim() || 'Lauri',
    dncMode,
    dncFile,
    llm: { buscador: list(env.LLM_BUSCADOR), vendedor: list(env.LLM_VENDEDOR), analista: list(env.LLM_ANALISTA) },
    googlePlacesKey: env.GOOGLE_PLACES_KEY?.trim() || undefined,
    google,
    hubUser: env.HUB_USER?.trim() || 'admin',
    hubPassword,
    contentDir: env.CONTENT_DIR?.trim() || 'content',
    waAuthDir: env.WA_AUTH_DIR?.trim() || 'wa_auth',
    replyDebounceSeconds: num('REPLY_DEBOUNCE_SECONDS', 30),
  };
}
