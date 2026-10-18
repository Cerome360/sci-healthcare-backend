import { buildApp } from './app.js';
import { disconnect } from './db.js';
import { env } from './env.js';
import { Indexer } from './stellar/indexer.js';
import { startTracingIfConfigured } from './tracing.js';

/**
 * SCI Healthcare API.
 *
 * Read-only by design. Every state change in this protocol is a signed
 * transaction built in the user's wallet and submitted straight to Soroban
 * RPC. This service holds no keys, signs nothing, and custodies no funds —
 * it exists to make on-chain state queryable, which the ledger alone is not.
 */
async function main(): Promise<void> {
  // No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (#54).
  startTracingIfConfigured();

  const app = await buildApp();

  const indexer = new Indexer(app.log);
  await indexer.start();

  let shuttingDown = false;

  /**
   * Stops the process in a defined order: new indexer cycles stop, the cycle
   * already in flight commits and saves its cursor (bounded by
   * `SHUTDOWN_TIMEOUT_MS`), then the HTTP server drains and the database
   * connection closes.
   *
   * The hard timer is the backstop for the whole sequence, a few seconds past
   * the indexer's own bound: a wedged socket or a stuck close must not leave
   * a deploy waiting on a process Render is about to SIGKILL anyway. Exiting
   * non-zero makes the unclean shutdown visible in the platform logs.
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info(
      { signal, timeoutMs: env.SHUTDOWN_TIMEOUT_MS },
      'shutting down: finishing the current indexer cycle, then closing the server',
    );

    const hardExit = setTimeout(() => {
      app.log.error(
        { signal, timeoutMs: env.SHUTDOWN_TIMEOUT_MS + 5_000 },
        'shutdown did not complete in time; exiting forcefully',
      );
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS + 5_000);
    hardExit.unref();

    try {
      await indexer.stop();
      await app.close();
      await disconnect();
      clearTimeout(hardExit);
      app.log.info({ signal }, 'shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err, signal }, 'shutdown failed; exiting');
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    {
      network: env.STELLAR_NETWORK,
      voucher: env.VOUCHER_CONTRACT_ID,
    },
    'sci-healthcare api listening',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
