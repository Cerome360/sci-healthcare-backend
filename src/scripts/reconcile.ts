import { parseArgs } from 'node:util';

import pino from 'pino';

import { disconnect } from '../db.js';
import { env } from '../env.js';
import { readVoucherFromChain, reconcile } from '../stellar/reconcile.js';

/**
 * Compares the stored vouchers with the contracts and reports the drift.
 *
 * Run it on a schedule. An indexer is a cache of the chain, and the poll
 * loop only ever moves forwards, so without a periodic comparison a missed
 * or mis-decoded event can sit unnoticed for weeks.
 *
 *   npm run indexer:reconcile                 # report only
 *   npm run indexer:reconcile -- --fix        # rewrite differing rows
 *   npm run indexer:reconcile -- --sample 100 # deeper spot-check of settled
 *
 * `--fix` only ever writes chain state into the database, never the other
 * way round: this service holds no keys and cannot change the chain.
 */
const { values } = parseArgs({
  options: {
    fix: { type: 'boolean', default: false },
    sample: { type: 'string' },
  },
  strict: true,
});

const sample = values.sample === undefined ? 25 : Number(values.sample);
if (!Number.isInteger(sample) || sample < 0) {
  console.error('--sample <n> must be a non-negative integer');
  process.exit(1);
}

const log = pino({ level: env.LOG_LEVEL });

async function main(): Promise<void> {
  log.info({ fix: values.fix, sample }, 'reconcile starting');

  const result = await reconcile({
    read: readVoucherFromChain,
    sample,
    fix: values.fix,
    log,
  });

  log.info(result, 'reconcile complete');
  console.log(JSON.stringify(result));
  await disconnect();

  // Non-zero while anything is still open, so cron or CI notices.
  process.exit(result.openMismatches > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
