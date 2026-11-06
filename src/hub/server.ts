import { serve } from '@hono/node-server';
import { loadConfig } from '../config.js';
import { createPgDb, migrate } from '../db/db.js';
import { WaGateway } from '../whatsapp/gateway.js';
import type { WaTransport } from '../whatsapp/transport.js';
import { createLlm } from '../llm/llm.js';
import { createVendedor } from '../agents/vendedor/vendedor.js';
import { createHubApp } from './app.js';

/** El hub no tiene sesión de WhatsApp: solo encola en el outbox y el worker se encarga de enviar. */
const nullTransport: WaTransport = {
  async start() {},
  async send() { throw new Error('El hub no envía mensajes directamente: lo hace el worker'); },
  async hasWhatsApp() { throw new Error('El hub no consulta WhatsApp'); },
  onIncoming() {},
  onStatus() {},
};

async function main() {
  const config = loadConfig(process.env);
  const db = createPgDb(config.databaseUrl);
  await migrate(db);
  const gateway = new WaGateway(db, nullTransport, config);
  const llm = createLlm(config, { db });
  const vendedor = createVendedor({ db, llm, gateway, config });
  const app = createHubApp({ db, config, answerEscalation: vendedor.answerEscalation });
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  console.log(`[hub] escuchando en :${port}`);
}

main().catch((e) => {
  console.error('[hub] fallo al iniciar', e);
  process.exit(1);
});
