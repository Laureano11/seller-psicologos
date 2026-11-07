// Fuerza una corrida del Buscador hoy, sin esperar a mañana.
// Uso (en el servidor): docker compose exec worker npm run buscador
// El worker la lanza en el próximo minuto, si ya pasó SEARCH_HOUR. El resultado se ve en el hub (/sistema, evento buscador_run).
import { createPgDb } from './db/db.js';
import { forceBuscadorToday } from './agents/buscador/run.js';

try {
  process.loadEnvFile('.env');
} catch {
  // sin .env: se usa el entorno actual
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('Falta DATABASE_URL');
const db = createPgDb(url);
await forceBuscadorToday(db);
await db.close();
console.log('Listo: el Buscador corre en el próximo minuto (si ya pasó SEARCH_HOUR).');
