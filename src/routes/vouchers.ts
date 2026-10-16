import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { isRefundable, isSettleable, refundableAt } from '../lib/lifecycle.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';
import { serviceKey, serviceLabels } from '../lib/services.js';

const STATUSES = [
  'Funded',
  'Claimed',
  'Attested',
  'Settled',
  'Disputed',
  'Refunded',
] as const;

/** Amounts are i128 base units carried as decimal strings. */
const BASE_UNITS = /^\d+$/;

const listQuery = z
  .object({
    funder: z.string().length(56).optional(),
    provider: z.string().length(56).optional(),
    beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters').optional(),
    status: z.enum(STATUSES).optional(),
    createdFrom: z.string().datetime({ offset: true }).optional(),
    createdTo: z.string().datetime({ offset: true }).optional(),
    minAmount: z.string().regex(BASE_UNITS, 'must be base units as an integer string').optional(),
    maxAmount: z.string().regex(BASE_UNITS, 'must be base units as an integer string').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine(
    (q) => !q.createdFrom || !q.createdTo || Date.parse(q.createdFrom) <= Date.parse(q.createdTo),
    { message: 'must not be later than createdTo', path: ['createdFrom'] },
  )
  .refine(
    (q) => !q.minAmount || !q.maxAmount || BigInt(q.minAmount) <= BigInt(q.maxAmount),
    { message: 'must not exceed maxAmount', path: ['minAmount'] },
  );

export async function voucherRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/vouchers',
    { config: { rateLimit: LIST_ROUTE_RATE_LIMIT } },
    async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
      }
      const {
        funder,
        provider,
        beneficiaryRef,
        status,
        createdFrom,
        createdTo,
        minAmount,
        maxAmount,
        limit,
        offset,
      } = parsed.data;

      // At least one selector is required. An unfiltered dump of every
      // voucher in the system is not a useful endpoint and invites scraping.
      if (
        !funder &&
        !provider &&
        !beneficiaryRef &&
        !status &&
        !createdFrom &&
        !createdTo &&
        !minAmount &&
        !maxAmount
      ) {
        return reply.code(400).send({
          error: 'filter_required',
          message:
            'Provide at least one of: funder, provider, beneficiaryRef, status, ' +
            'createdFrom, createdTo, minAmount, maxAmount',
        });
      }

      const where: Prisma.VoucherWhereInput = {
        ...(funder ? { funder } : {}),
        ...(provider ? { providerAddress: provider } : {}),
        ...(beneficiaryRef ? { beneficiaryRef } : {}),
        ...(status ? { status } : {}),
        ...(createdFrom || createdTo
          ? {
              createdAt: {
                ...(createdFrom ? { gte: new Date(createdFrom) } : {}),
                ...(createdTo ? { lte: new Date(createdTo) } : {}),
              },
            }
          : {}),
      };

      const min = minAmount === undefined ? null : BigInt(minAmount);
      const max = maxAmount === undefined ? null : BigInt(maxAmount);

      const { rows, total } =
        min === null && max === null
          ? await pageByWhere(where, limit, offset)
          : await pageByAmount(where, min, max, limit, offset);

      const labels = await serviceLabels(rows);
      return { total, limit, offset, vouchers: rows.map((v) => serialise(v, labels)) };
    },
  );

  app.get('/vouchers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const v = await prisma.voucher.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (!v) return reply.code(404).send({ error: 'voucher_not_found' });

    const [receipt, labels] = await Promise.all([
      prisma.receipt.findUnique({ where: { voucherId: id } }),
      serviceLabels([v]),
    ]);
    return { ...serialise(v, labels), receipt };
  });
}

/** The common path: filter, count and page entirely in the database. */
async function pageByWhere(
  where: Prisma.VoucherWhereInput,
  limit: number,
  offset: number,
): Promise<{ rows: Row[]; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.voucher.findMany({
      where,
      include: { provider: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.voucher.count({ where }),
  ]);
  return { rows, total };
}

/**
 * Amounts are i128 carried as strings, so the database cannot compare them
 * numerically — string ordering puts "9" after "10". Compare with BigInt
 * instead, then fetch only the requested page.
 */
async function pageByAmount(
  where: Prisma.VoucherWhereInput,
  min: bigint | null,
  max: bigint | null,
  limit: number,
  offset: number,
): Promise<{ rows: Row[]; total: number }> {
  const candidates = await prisma.voucher.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: { id: true, amount: true },
  });

  const matching = candidates.filter((c) => {
    const amount = BigInt(c.amount);
    return (min === null || amount >= min) && (max === null || amount <= max);
  });

  const ids = matching.slice(offset, offset + limit).map((c) => c.id);
  if (ids.length === 0) return { rows: [], total: matching.length };

  const rows = await prisma.voucher.findMany({
    where: { id: { in: ids } },
    include: { provider: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows: ids.map((id) => byId.get(id)!), total: matching.length };
}

type Row = {
  id: string;
  funder: string;
  beneficiaryRef: string;
  serviceCode: number;
  amount: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  attestedAt: Date | null;
  disputeDeadline: Date | null;
  disputeReason: number | null;
  settledNet: string | null;
  settledFee: string | null;
  providerAddress: string;
  provider: { name: string; country: string };
};

function serialise(v: Row, labels: Map<string, string>) {
  const refundable = refundableAt(v);
  return {
    id: v.id,
    funder: v.funder,
    beneficiaryRef: v.beneficiaryRef,
    provider: {
      address: v.providerAddress,
      name: v.provider.name,
      country: v.provider.country,
    },
    serviceCode: v.serviceCode,
    serviceLabel: labels.get(serviceKey(v.providerAddress, v.serviceCode)) ?? null,
    amount: v.amount,
    amountDisplay: fromBaseUnits(v.amount),
    status: v.status,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    claimedAt: v.claimedAt,
    attestedAt: v.attestedAt,
    disputeDeadline: v.disputeDeadline,
    disputeReason: v.disputeReason,
    settledNet: v.settledNet,
    settledFee: v.settledFee,
    // Convenience flags so the UI does not re-derive the state machine.
    refundableAt: refundable,
    isSettleable: isSettleable(v),
    isRefundable: isRefundable(v),
  };
}
