import { prisma } from '../db.js';

/**
 * What a receipt needs in order to name the clinic that issued it. An
 * address is what the chain records; a name is what a patient recognises.
 */
export type ProviderSummary = {
  address: string;
  name: string;
  country: string;
};

/**
 * Looks up clinic names and countries for a batch of rows in one query, so
 * a list of receipts can say "Ikeja General Clinic" instead of a 56-character
 * Stellar address.
 *
 * Same shape as `serviceLabels()` in `src/lib/services.ts`: the addresses are
 * collected first and read with a single `where in`, never one query per row.
 *
 * A row whose provider is absent from the read model simply is not in the
 * returned map. That happens when the indexer started after the clinic
 * registered, and the caller is expected to render the name as unknown
 * rather than invent one.
 */
export async function providerSummaries(
  rows: readonly { providerAddress: string }[],
): Promise<Map<string, ProviderSummary>> {
  const addresses = [...new Set(rows.map((r) => r.providerAddress))];
  if (addresses.length === 0) return new Map();

  const providers = await prisma.provider.findMany({
    where: { address: { in: addresses } },
    select: { address: true, name: true, country: true },
  });
  return new Map(providers.map((p) => [p.address, p]));
}
