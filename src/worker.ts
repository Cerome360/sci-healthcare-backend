import { pathToFileURL } from 'node:url';

import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';

import { disconnect } from './db.js';
import { env } from './env.js';
import { WebhookDispatcher } from './lib/webhooks.js';
import { Indexer } from './stellar/indexer.js';
import { startTracingIfConfigured } from './tracing.js';

/**
 * The indexer on its own, with no HTTP server in the process.
 *
 * Combined mode (`src/index.ts`) is the default; this entry point is for
 * deployments that run the indexer as a separate service. Only one instance
 * actually indexes at a time — the lease in `src/stellar/lease.ts` keeps
 * every other instance in standby.
 */
export type WorkerOptions = {
  logger?: FastifyBaseLogger;
};

export async function start(opts: WorkerOptions = {}): Promise<Indexer> {
  // No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (#54).
  startTracingIfConfigured();

  const log: FastifyBaseLogger = opts.logger ?? pino({ level: env.LOG_LEVEL });
  const indexer = new Indexer(log);

  const webhooks = new WebhookDispatcher(log);
  webhooks.start();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(
      { signal, timeoutMs: env.SHUTDOWN_TIMEOUT_MS },
      'shutting down indexer: finishing the current cycle',
    );
    try {
      await webhooks.stop();
      await indexer.stop();
      await disconnect();
      log.info({ signal }, 'indexer shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err, signal }, 'indexer shutdown failed; exiting');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await indexer.start();
  log.info({ network: env.STELLAR_NETWORK }, 'sci-healthcare indexer running');
  return indexer;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
