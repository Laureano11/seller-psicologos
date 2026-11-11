// Buscador: corre en tu Mac (sin Docker). Lanza el agente de Claude, que busca psicólogos en el navegador,
// y agrega los nuevos a data/prospectos.json. El worker los toma de ahí y los carga a la base.
// Uso: npm run buscador          (hasta 10 nuevos por corrida)
//      npm run buscador -- 20    (otro máximo)
// Necesita Claude Code instalado y logueado (`claude`). No usa claves ni variables de entorno.
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCorrida } from './agents/buscador/corrida.js';
import { createClaudeRunner } from './agents/buscador/claude.js';

const DATA_DIR = 'data';
const LOCK = join(DATA_DIR, 'buscador.lock');
const DEFAULT_MAX = 10;
const PAGE_TIMEOUT_MS = 15_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'es-AR' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const max = Number(process.argv[2] ?? DEFAULT_MAX);
if (!Number.isInteger(max) || max < 1) {
  console.error(`El máximo tiene que ser un número entero positivo (recibido "${process.argv[2]}")`);
  process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8'));
  if (Number.isInteger(pid) && alive(pid)) {
    console.log(`Ya hay una corrida del Buscador en curso (proceso ${pid}). No hago nada.`);
    process.exit(0);
  }
}
writeFileSync(LOCK, String(process.pid));

const started = new Date();
console.log(`[${started.toISOString()}] Buscador: hasta ${max} psicólogos nuevos.`);
try {
  const r = await runCorrida({
    dataDir: DATA_DIR,
    contentDir: 'content',
    claude: createClaudeRunner({ profileDir: 'browser_profile', timeoutMs: 30 * 60_000, maxTurns: 150, model: 'sonnet' }),
    fetchPage,
    max,
    now: started,
  });
  console.log(`Ciudad: ${r.ciudad}. Claude trajo ${r.hallados}, guardados ${r.guardados}.`);
  if (Object.keys(r.descartes).length) console.log('Descartados:', r.descartes);
  if (r.borradosPorBaja) console.log(`Borrados por baja: ${r.borradosPorBaja}`);
  console.log(`Listo: ${join(DATA_DIR, 'prospectos.json')}`);
} catch (e) {
  console.error(`El Buscador falló: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  rmSync(LOCK, { force: true });
}
