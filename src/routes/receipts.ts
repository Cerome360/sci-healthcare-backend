import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';
import { serviceKey, serviceLabels } from '../lib/services.js';

const query = z.object({
  beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A patient's care history.
   *
   * Requires an exact beneficiary reference. Because that reference is an
   * HMAC computed under a key the patient holds, only someone who already
   * knows the patient's identifier and key can construct it — the endpoint
   * cannot be walked to enumerate patients.
   */
  app.get('/receipts', { config: { rateLimit: LIST_ROUTE_RATE_LIMIT } }, async (req, reply) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { beneficiaryRef, limit, offset } = parsed.data;

    const [rows, total, spend] = await Promise.all([
      prisma.receipt.findMany({
        where: { beneficiaryRef },
        orderBy: { settledAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.receipt.count({ where: { beneficiaryRef } }),
      prisma.receipt.findMany({
        where: { beneficiaryRef },
        select: { amount: true },
      }),
    ]);

    const labels = await serviceLabels(rows);
    const totalSpend = spend
      .reduce((acc, r) => acc + BigInt(r.amount), 0n)
      .toString();

    return {
      total,
      limit,
      offset,
      totalSpend,
      totalSpendDisplay: fromBaseUnits(totalSpend),
      receipts: rows.map((r) => ({
        voucherId: r.voucherId,
        providerAddress: r.providerAddress,
        serviceCode: r.serviceCode,
        serviceLabel: labels.get(serviceKey(r.providerAddress, r.serviceCode)) ?? null,
        amount: r.amount,
        amountDisplay: fromBaseUnits(r.amount),
        settledAt: r.settledAt,
      })),
    };
  });
}
