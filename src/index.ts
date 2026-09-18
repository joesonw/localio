#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { loadConfig, UsageError, usage, wantsHelp } from './config.js';
import { Store } from './db/index.js';
import { applySeed, seedSchema } from './routes/admin.js';
import { LocalioServer } from './server.js';

/**
 * The entrypoint, and **the only place that reads the environment or the command line**.
 *
 * Everything below takes plain values through a constructor. That is the same rule the
 * app this was extracted from held, for the same reason: configuration read half way down
 * a call stack is configuration nobody can find, and a test then has to set environment
 * variables to reach it.
 *
 * Three things happen here that happen nowhere else: the config is parsed, the database is
 * opened and migrated, and the seed file — if there is one — is applied.
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    // Nothing is open yet, so returning is enough — the process exits 0 on its own.
    console.log(usage());
    return;
  }

  const config = loadConfig(process.env, argv);
  const logger = pino({
    level: config.logLevel,
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
  });

  const store = Store.open({ path: config.dbPath, recordingsDir: config.recordingsDir });

  if (config.seedPath) {
    // Fatal rather than warned. A seed that did not apply leaves the simulator running
    // with no numbers, and every call then fails as `no_such_number` — which sends
    // whoever is using it hunting the wrong thing entirely.
    const seed = seedSchema.parse(JSON.parse(readFileSync(config.seedPath, 'utf8')));
    const applied = applySeed(store, seed);
    logger.info({ ...applied, file: config.seedPath }, 'applied the seed');
  }

  const server = new LocalioServer({ store, config, logger });
  await server.listen();

  logger.info(
    {
      url: `http://${config.host}:${config.port}`,
      publicUrl: config.publicUrl,
      db: config.dbPath,
      recordings: config.recordingsDir,
      accounts: store.accounts.list().length,
      numbers: store.numbers.list().length,
    },
    'localio is up',
  );

  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    // Loudly, and every time. Nothing in this process authenticates: `/admin` hands out
    // auth tokens, the REST API creates numbers, and the recordings route serves audio
    // to anybody who asks. It is a development tool.
    logger.warn(
      { host: config.host },
      'localio is listening off loopback. Nothing here is authenticated: /admin hands out auth tokens and /2010-04-01 recordings are served without credentials. Do not deploy this.',
    );
  }
  if (store.numbers.list().length === 0) {
    logger.warn(
      'no phone numbers yet — add one in the Numbers panel, or pass --seed / set SEED. Until then every call answers no_such_number',
    );
  }

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    // Calls are ended first so each posts its status callback — a simulator that
    // vanishes mid-call leaves the application under test holding one forever.
    void server
      .close()
      .catch((error: unknown) => logger.error({ err: error }, 'shutdown was not clean'))
      .finally(() => {
        store.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // Before a logger exists, or after it has failed. Either way this has to say something.
  if (error instanceof UsageError) {
    // The mistake is in what was typed. A stack trace would only bury the one useful line.
    console.error(error.message);
  } else {
    console.error('localio failed to start:', error);
  }
  process.exit(1);
});
