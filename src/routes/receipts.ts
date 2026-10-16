import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { ApiError } from '../lib/errors.js';
import { serviceKey, serviceLabels } from '../lib/services.js';

const listQuery = z
  .object({
    beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters').optional(),
    provider: z.string().length(56).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((data) => Boolean(data.beneficiaryRef) !== Boolean(data.provider), {
    message: 'Provide exactly one of: beneficiaryRef, provider',
    path: ['beneficiaryRef', 'provider'],
  });

const voucherIdParam = z.object({
  voucherId: z.string().min(1),
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
  app.get('/receipts', async (req) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { beneficiaryRef, provider, limit, offset } = parsed.data;

    const where = beneficiaryRef
      ? { beneficiaryRef }
      : { providerAddress: provider! };

    const [rows, total, spend] = await Promise.all([
      prisma.receipt.findMany({
        where,
        orderBy: { settledAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.receipt.count({ where }),
      prisma.receipt.findMany({
        where,
        select: { amount: true },
      }),
    ]);

    const labels = await serviceLabels(rows);
    const totalSpend = spend
      .reduce((acc, r) => acc + BigInt(r.amount), 0n)
      .toString();

    const isProviderView = Boolean(provider);
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
        ...(isProviderView ? {} : { beneficiaryRef: r.beneficiaryRef }),
      })),
    };
  });

  /**
   * Single receipt by voucher ID.
   *
   * Used for shareable receipt pages and verification. No beneficiary
   * reference is included in the response.
   */
  app.get('/receipts/:voucherId', async (req) => {
    const parsed = voucherIdParam.safeParse(req.params);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { voucherId } = parsed.data;

    const receipt = await prisma.receipt.findUnique({
      where: { voucherId },
    });
    if (!receipt) throw new ApiError(404, 'receipt_not_found', 'Receipt not found');

    const labels = await serviceLabels([receipt]);
    return {
      voucherId: receipt.voucherId,
      providerAddress: receipt.providerAddress,
      serviceCode: receipt.serviceCode,
      serviceLabel: labels.get(serviceKey(receipt.providerAddress, receipt.serviceCode)) ?? null,
      amount: receipt.amount,
      amountDisplay: fromBaseUnits(receipt.amount),
      settledAt: receipt.settledAt,
    };
  });
}
