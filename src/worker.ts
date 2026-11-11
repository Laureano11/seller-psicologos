import { loadConfig } from './config.js';
import { createPgDb, migrate } from './db/db.js';
import { seedKnowledge } from './db/repo.js';
import { createBaileysTransport } from './whatsapp/baileys.js';
import { WaGateway } from './whatsapp/gateway.js';
import { createLlm } from './llm/llm.js';
import { createDncChecker, reportDncStatus } from './dnc.js';
import { runImportador } from './agents/buscador/importar.js';
import { createGoogleServices } from './agents/agenda/google.js';
import { createVendedor } from './agents/vendedor/vendedor.js';
import { runWeeklyAnalysis } from './learning/analysis.js';
import { createOrchestrator } from './orchestrator/orchestrator.js';

async function main() {
  const config = loadConfig(process.env);
  const db = createPgDb(config.databaseUrl);
  await migrate(db);
  await seedKnowledge(db, config.contentDir);

  const transport = createBaileysTransport(config.waAuthDir);
  const gateway = new WaGateway(db, transport, config);
  const llm = createLlm(config, { db });
  const dnc = createDncChecker(config);
  // si falta el archivo No Llame no se cae (evita el reinicio en bucle): evento + banner en el hub
  if (!(await reportDncStatus(db, dnc))) console.error(`[worker] falta el archivo No Llame: ${config.dncFile}`);
  const google = config.google ? createGoogleServices(config.google) : undefined;
  const vendedor = createVendedor({ db, llm, gateway, calendar: google?.calendar, mail: google?.mail, config });

  const importDeps = { db, dnc, wa: transport, config, dataDir: config.dataDir };

  const orch = createOrchestrator({
    db, config, gateway, vendedor,
    runImportador: (now, signal) => runImportador(importDeps, now, signal),
    runWeeklyAnalysis: (now) => runWeeklyAnalysis({ db, llm, config }, now),
  });

  transport.onIncoming((m) => {
    orch.onIncoming(m, new Date()).catch((e) => console.error('[worker] error en mensaje entrante', e));
  });
  transport.onStatus((s) => {
    orch.onWaStatus(s, new Date()).catch((e) => console.error('[worker] error en estado de WhatsApp', e));
  });
  await transport.start();

  const timer = setInterval(() => {
    orch.tick(new Date()).catch((e) => console.error('[worker] error en tick', e));
  }, 60_000);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    orch.stop();
    await orch.idle();
    // la importación se corta en su próxima pausa; se le dan hasta 8 s para cerrar y guardar sus contadores
    await Promise.race([orch.idleImportador(), new Promise((r) => setTimeout(r, 8_000))]);
    await transport.stop?.().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(
    `[worker] iniciado: tz=${config.tz} datos=${config.dataDir} google=${google ? 'si' : 'no'} dnc=${config.dncMode}`,
  );
}

main().catch((e) => {
  console.error('[worker] fallo al iniciar', e);
  process.exit(1);
});
