'use strict';

const { loadDotEnv } = require('./src/config');

loadDotEnv();

const { createApp } = require('./src/app');

async function main() {
  const app = createApp();
  await app.listen();
  const proto = app.cfg.tls ? 'https' : 'http';
  app.log.info(`NOMEIA ouvindo em ${proto}://${app.cfg.host}:${app.port} (dados em ${app.cfg.dataDir})`);
  app.log.info(`Administração: ${proto}://localhost:${app.port}/admin.html`);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    app.log.info(`Recebido ${signal}: finalizando gravações pendentes...`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((err) => {
  console.error(`Falha ao iniciar: ${err.message}`);
  process.exit(1);
});
