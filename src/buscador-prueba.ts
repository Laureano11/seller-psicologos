// Prueba del Buscador SOLO, en esta máquina: sin Docker, sin WhatsApp, sin base de datos real, sin escribirle a nadie.
// Uso: npm run buscador:prueba            (topes chicos por defecto: 2 búsquedas, 10 páginas, 5 prospectos)
//      npm run buscador:prueba -- 5 30 20  (búsquedas, páginas, prospectos)
// Necesita solo una clave de IA en .env (GOOGLE_GENERATIVE_AI_API_KEY o GROQ_API_KEY).
// Como no hay WhatsApp conectado, NO verifica si el número tiene WhatsApp (todos pasan) y no consulta el No Llame:
// el resultado es una muestra de lo que encontraría, no una lista lista para contactar.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createMemoryDb, migrate } from './db/db.js';
import { listProspectsForHub } from './db/repo.js';
import { createLlm } from './llm/llm.js';
import { createDncChecker } from './dnc.js';
import { runBuscador } from './agents/buscador/run.js';
import { launchBrowser } from './agents/buscador/browser.js';
import { engineOrder } from './agents/buscador/engines.js';
import { createRobotsChecker } from './agents/buscador/robots.js';

try {
  process.loadEnvFile('.env');
} catch {
  // sin .env: se usa el entorno actual
}

const [searches = '2', pages = '10', max = '5'] = process.argv.slice(2);
const config = loadConfig({
  ...process.env,
  DATABASE_URL: 'memoria',
  OWNER_WA_ID: '5490000000001', // no se usa: los avisos salen por consola
  DNC_MODE: 'off',
  BUSCADOR_MAX_SEARCHES: searches,
  BUSCADOR_MAX_PAGES: pages,
  BUSCADOR_MAX_PER_DAY: max,
  BUSCADOR_PROFILE_DIR: process.env.BUSCADOR_PRUEBA_PROFILE_DIR ?? 'browser_profile_prueba',
  BUSCADOR_SEARCH_DELAY: process.env.BUSCADOR_SEARCH_DELAY ?? '8-15',
  CONTENT_DIR: 'content',
});

const db = await createMemoryDb();
await migrate(db);
const ac = new AbortController();
process.on('SIGINT', () => { console.log('\nCortando en la próxima pausa…'); ac.abort(); });

console.log(`Buscador de prueba: hasta ${searches} búsquedas, ${pages} páginas, ${max} prospectos. Motor: ${config.buscador.engine}. Ctrl+C corta.\n`);
const result = await runBuscador(
  {
    db, config, contentDir: config.contentDir,
    llm: createLlm(config, { db }),
    dnc: createDncChecker(config),
    wa: { hasWhatsApp: async () => true },
    sources: [],
    openBrowser: () => launchBrowser({ profileDir: config.buscador.profileDir, tz: config.tz }),
    engines: engineOrder(config.buscador.engine),
    robots: createRobotsChecker(),
    notifyOwner: async (t: string) => { console.log(`[aviso al dueño] ${t}`); },
  },
  new Date(),
  ac.signal,
);

const found = await listProspectsForHub(db);
console.log('\nResultado:', JSON.stringify(result, null, 2));
if (found.length) {
  console.table(found.map((p) => ({ nombre: p.name, celular: p.phoneRaw, email: p.email ?? '', ciudad: p.city ?? '', pagina: p.sourceRef ?? '' })));
  mkdirSync('data', { recursive: true });
  const file = join('data', 'prueba-buscador.csv');
  const esc = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = found.map((p) => [p.name, p.phoneRaw, p.waId, p.email, p.city, p.sourceRef].map(esc).join(','));
  writeFileSync(file, ['nombre,celular,wa_id,email,ciudad,pagina', ...rows].join('\n') + '\n');
  console.log(`\nGuardado en ${file}`);
} else {
  console.log('\nNo encontró a nadie esta vez (mirá stopReason y skipped arriba).');
}
await db.close();
process.exit(0);
