import { buildApp } from './app.js';
import { disconnect } from './db.js';
import { env } from './env.js';
import { Indexer } from './stellar/indexer.js';

/**
 * SCI Healthcare API.
 *
 * Read-only by design. Every state change in this protocol is a signed
 * transaction built in the user's wallet and submitted straight to Soroban
 * RPC. This service holds no keys, signs nothing, and custodies no funds —
 * it exists to make on-chain state queryable, which the ledger alone is not.
 */
async function main(): Promise<void> {
  const app = await buildApp();

  const indexer = new Indexer(app.log);
  await indexer.start();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await indexer.stop();
    await app.close();
    await disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

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
