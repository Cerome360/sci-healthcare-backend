/**
 * `npx prisma db seed` / `npm run db:seed` entry point (issue #59).
 *
 * The dataset itself lives in `src/scripts/seed.ts`, which the test suite
 * drives against the throwaway database. This file only wires it to the
 * environment: it refuses to run unless `DATABASE_URL` points at a local
 * database, and reads the optional `SEED_VOUCHERS` override.
 *
 *   npm run db:seed                 # 2 500 vouchers, 12 clinics
 *   SEED_VOUCHERS=100000 npm run db:seed   # stress seed for query plans
 */
import { PrismaClient } from '@prisma/client';

import { assertLocalDatabase, seedLocalData } from '../src/scripts/seed.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first (prisma loads it for the seed script).');
  process.exit(1);
}

// Guard first: fabricated rows are only ever legitimate in a local
// projection of the chain. Never against a deployed database.
assertLocalDatabase(databaseUrl);

const vouchers = process.env.SEED_VOUCHERS ? Number(process.env.SEED_VOUCHERS) : undefined;
if (vouchers !== undefined && !Number.isInteger(vouchers)) {
  console.error(`SEED_VOUCHERS must be an integer, got "${process.env.SEED_VOUCHERS}"`);
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const summary = await seedLocalData(prisma, { vouchers });
  console.log(
    `Seeded local data: ${summary.providers} clinics, ${summary.services} services, ` +
      `${summary.vouchers} vouchers (every status), ${summary.receipts} receipts.`,
  );
} finally {
  await prisma.$disconnect();
}
