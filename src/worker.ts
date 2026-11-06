import { loadConfig } from './config.js';
import { createPgDb, migrate } from './db/db.js';
import { seedKnowledge } from './db/repo.js';
import { createBaileysTransport } from './whatsapp/baileys.js';
import { WaGateway } from './whatsapp/gateway.js';
import { createLlm } from './llm/llm.js';
import { createDncChecker } from './dnc.js';
import { createGooglePlacesSource, type ProspectSource } from './agents/buscador/sources.js';
import { runBuscador } from './agents/buscador/run.js';
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
  const sources: ProspectSource[] = config.googlePlacesKey ? [createGooglePlacesSource(config.googlePlacesKey)] : [];
  const google = config.google ? createGoogleServices(config.google) : undefined;
  const vendedor = createVendedor({ db, llm, gateway, calendar: google?.calendar, mail: google?.mail, config });

  const orch = createOrchestrator({
    db, config, gateway, vendedor,
    runBuscador: (now) => runBuscador({ db, llm, dnc, sources, wa: transport, config }, now),
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

  const shutdown = async () => {
    clearInterval(timer);
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(
    `[worker] iniciado: tz=${config.tz} buscador=${sources.length ? 'places' : 'sin fuentes'} google=${google ? 'si' : 'no'} dnc=${config.dncMode}`,
  );
}

main().catch((e) => {
  console.error('[worker] fallo al iniciar', e);
  process.exit(1);
});
