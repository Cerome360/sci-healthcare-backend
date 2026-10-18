import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { disconnect } from './db.js';
import { env } from './env.js';
import { startTracingIfConfigured } from './tracing.js';

/**
 * The HTTP API on its own, with no indexer in the process.
 *
 * Combined mode (`src/index.ts`) is the default and is what the one-click
 * deploy uses; this entry point is for deployments that scale the API and
 * the indexer independently. The API stays read-only either way.
 */
export type ApiOptions = {
  port?: number;
  host?: string;
};

export async function start(opts: ApiOptions = {}): Promise<FastifyInstance> {
  // No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (#54).
  startTracingIfConfigured();

  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down api');
    await app.close();
    await disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  const port = opts.port ?? env.PORT;
  const host = opts.host ?? env.HOST;
  await app.listen({ port, host });
  app.log.info({ mode: 'api', port, host }, 'sci-healthcare api listening');
  return app;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
