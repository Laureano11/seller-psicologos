// Flujo OAuth local para obtener GOOGLE_REFRESH_TOKEN.
// Uso: npm run google:auth  (requiere GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en .env o en el entorno)
import http from 'node:http';
import { google } from 'googleapis';

const PORT = 5555;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/gmail.send',
];

try {
  process.loadEnvFile('.env');
} catch {
  // sin .env: se usa el entorno actual
}

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Faltan GOOGLE_CLIENT_ID y/o GOOGLE_CLIENT_SECRET (completalos en .env).');
  process.exit(1);
}

const oauth = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (u.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const code = u.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Falta el parametro code');
    return;
  }
  try {
    const { tokens } = await oauth.getToken(code);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Listo. Volvé a la terminal y copiá el GOOGLE_REFRESH_TOKEN.');
    if (!tokens.refresh_token) {
      console.error('Google no devolvió refresh_token. Revocá el acceso de la app en https://myaccount.google.com/permissions y repetí.');
      process.exitCode = 1;
    } else {
      console.log('\nAgregá esto a tu .env:\n');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    }
  } catch (e) {
    res.writeHead(500).end('Error al intercambiar el código');
    console.error('Error:', e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('Abrí esta URL en el navegador y autorizá el acceso:\n');
  console.log(url + '\n');
  console.log(`Esperando el callback en ${REDIRECT} ...`);
});
