import { Readable } from 'node:stream';

import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { voucherSeq } from '../lib/voucher_seq.js';
import { csvRow } from '../lib/csv.js';
import { cursorParam, decodeCursor, encodeCursor, limitParam } from '../lib/cursor.js';
import { ApiError } from '../lib/errors.js';
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

const statusList = z
  .string()
  .max(256)
  .transform((s) => s.split(',').map((x) => x.trim()))
  .pipe(z.array(z.enum(STATUSES)).min(1));

const listQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  beneficiaryRef: z
    .string()
    .max(64)
    .refine(isValidRef, 'must be 64 hex characters')
    .optional(),
  status: statusList.optional(),
  createdFrom: z.string().max(64).datetime({ offset: true }).optional(),
  createdTo: z.string().max(64).datetime({ offset: true }).optional(),
  minAmount: z
    .string()
    .max(64)
    .regex(BASE_UNITS, 'must be base units as an integer string')
    .optional(),
  maxAmount: z
    .string()
    .max(64)
    .regex(BASE_UNITS, 'must be base units as an integer string')
    .optional(),
  sort: z.enum(['createdAt', 'expiresAt', 'amount']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  cursor: cursorParam,
  limit: limitParam,
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

/** The CSV export takes the filters but none of the paging or sort options. */
const csvQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  beneficiaryRef: z
    .string()
    .max(64)
    .refine(isValidRef, 'must be 64 hex characters')
    .optional(),
  status: statusList.optional(),
});

/** Columns exported as CSV. Deliberately no beneficiary reference. */
const CSV_COLUMNS = [
  'id',
  'funder',
  'providerAddress',
  'providerName',
  'providerCountry',
  'serviceCode',
  'serviceLabel',
  'amount',
  'amountDisplay',
  'status',
  'createdAt',
  'expiresAt',
  'claimedAt',
  'attestedAt',
  'disputeDeadline',
  'disputeReason',
  'settledNet',
  'settledFee',
  'refundableAt',
  'isSettleable',
  'isRefundable',
];

/** Rows fetched per database round trip; keeps export memory flat. */
const CSV_BATCH_SIZE = 500;

/**
 * The id part of an order-by: `seq` (the numeric voucher id) first, then the
 * string `id` as the final tie-break (#61).
 *
 * Sorting by `id` alone is lexicographic and puts voucher 10 before voucher 9.
 * `seq` is that same value as a number. Rows with no seq — a locally-authored
 * fixture id like `bulk-0001`, which has nothing numeric to mirror — sort last
 * in both directions, so the total order stays deterministic and no row can
 * fall between two pages.
 */
function idOrder(order: 'asc' | 'desc'): Prisma.VoucherOrderByWithRelationInput[] {
  return [{ seq: { sort: order, nulls: 'last' } }, { id: order }];
}

const dueQuery = z.object({
  funder: z.string().length(56).optional(),
  provider: z.string().length(56).optional(),
  within: z
    .string()
    .max(16)
    .regex(/^\d+[hmd]$/, 'within must be like 72h, 30d, or 45m'),
});

export async function voucherRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/vouchers',
    { config: { rateLimit: LIST_ROUTE_RATE_LIMIT } },
    async (req) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
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
        sort,
        order,
        cursor,
        limit,
        offset,
      } = parsed.data;

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
        throw new ApiError(
          400,
          'filter_required',
          'Provide at least one of: funder, provider, beneficiaryRef, status, createdFrom, createdTo, minAmount, maxAmount',
        );
      }

      const where: Prisma.VoucherWhereInput = {
        ...(funder ? { funder } : {}),
        ...(provider ? { providerAddress: provider } : {}),
        ...(beneficiaryRef ? { beneficiaryRef } : {}),
        ...(status ? { status: { in: status } } : {}),
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

      if (cursor) {
        const decoded = decodeCursor(cursor);
        if (!decoded) {
          throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
        }
        /**
         * The walk below is ordered by `(createdAt, seq, id)`, where `seq` is
         * the numeric voucher id — ordering by the `id` string would put
         * voucher 10 before voucher 9 (#61). A keyset predicate has to compare
         * the columns it orders by, so the cursor row's own `seq` is read
         * here: one lookup by primary key, exact even for a row whose `seq` is
         * null because its id was hand-written (`bulk-0001`) rather than
         * indexed off the chain.
         */
        const cursorRow = await prisma.voucher.findUnique({
          where: { id: decoded.id },
          select: { seq: true },
        });
        // A cursor can outlive its row (a rebuilt read model, a pruned
        // fixture): then the id's own numeric value is all there is to go on.
        const cursorSeq = cursorRow ? cursorRow.seq : voucherSeq(decoded.id);
        const at = new Date(decoded.createdAt);
        const afterCursor: Prisma.VoucherWhereInput[] =
          cursorSeq === null
            ? [
                { createdAt: { lt: at } },
                // The cursor row is in the unnumbered tail, which is ordered
                // by id, so the boundary is an id comparison.
                { createdAt: at, seq: null, id: { lt: decoded.id } },
              ]
            : [
                { createdAt: { lt: at } },
                { createdAt: at, seq: { lt: cursorSeq } },
                // Same numeric id, different string id — only reachable for
                // ids that differ in form alone (`9` and `09`). Listed so the
                // predicate matches the `id` tie-break of the order exactly.
                { createdAt: at, seq: cursorSeq, id: { lt: decoded.id } },
                // Rows with no seq sort after every numbered one.
                { createdAt: at, seq: null },
              ];
        const cursorWhere: Prisma.VoucherWhereInput = { ...where, OR: afterCursor };
        const rows =
          min === null && max === null
            ? await prisma.voucher.findMany({
                where: cursorWhere,
                include: { provider: true },
                orderBy: [{ createdAt: 'desc' }, ...idOrder('desc')],
                take: limit + 1,
              })
            : (
                await pageByAmount(
                  cursorWhere,
                  min,
                  max,
                  'createdAt',
                  'desc',
                  limit + 1,
                  0,
                )
              ).rows;
        const hasNext = rows.length > limit;
        const page = hasNext ? rows.slice(0, limit) : rows;
        const labels = await serviceLabels(page);
        const last = page[page.length - 1];
        const nextCursor = hasNext && last ? encodeCursor(last.createdAt, last.id) : null;
        return { limit, nextCursor, vouchers: page.map((v) => serialise(v, labels)) };
      }

      const { rows, total } =
        min === null && max === null && sort !== 'amount'
          ? await pageByWhere(where, sort, order, limit, offset)
          : await pageByAmount(where, min, max, sort, order, limit, offset);

      const labels = await serviceLabels(rows);
      return { total, limit, offset, vouchers: rows.map((v) => serialise(v, labels)) };
    },
  );

  /**
   * The same vouchers as JSON `GET /vouchers`, as a streamed CSV download.
   *
   * At least one filter is required here too, so the export cannot become
   * an unauthenticated dump of every voucher. Rows are read in batches with
   * a cursor and written out as they arrive: the whole export never has to
   * fit in memory, however many rows match. There is deliberately no
   * beneficiary reference column.
   */
  app.get('/vouchers.csv', async (req, reply) => {
    const parsed = csvQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { funder, provider, beneficiaryRef, status } = parsed.data;

    if (!funder && !provider && !beneficiaryRef && !status) {
      throw new ApiError(
        400,
        'filter_required',
        'Provide at least one of: funder, provider, beneficiaryRef, status',
      );
    }

    const where: Prisma.VoucherWhereInput = {
      ...(funder ? { funder } : {}),
      ...(provider ? { providerAddress: provider } : {}),
      ...(beneficiaryRef ? { beneficiaryRef } : {}),
      ...(status ? { status: { in: status } } : {}),
    };

    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="vouchers.csv"')
      .header('cache-control', 'no-store');

    return reply.send(Readable.from(voucherCsv(where), { objectMode: false }));
  });

  app.get(
    '/vouchers/due',
    { config: { rateLimit: LIST_ROUTE_RATE_LIMIT } },
    async (req) => {
      const parsed = dueQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const { funder, provider, within } = parsed.data;

      if (!funder && !provider) {
        throw new ApiError(400, 'filter_required', 'Provide at least one of: funder, provider');
      }

      const now = Date.now();
      const deadline = parseWithin(within, now);

      const where = {
        ...(funder ? { funder } : {}),
        ...(provider ? { providerAddress: provider } : {}),
        status: { in: ['Funded', 'Claimed', 'Attested'] },
      };

      const rows = await prisma.voucher.findMany({
        where,
        include: { provider: true },
        orderBy: { expiresAt: 'asc' },
      });

      const labels = await serviceLabels(rows);
      const due = rows
        .filter((v) => {
          const timing = {
            status: v.status,
            expiresAt: v.expiresAt,
            disputeDeadline: v.disputeDeadline,
          };
          return isRefundable(timing, deadline) || isSettleable(timing, deadline);
        })
        .map((v) => serialise(v, labels));

      return { total: due.length, vouchers: due };
    },
  );

  app.get('/vouchers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const v = await prisma.voucher.findUnique({
      where: { id },
      include: { provider: true },
    });
    if (!v) throw new ApiError(404, 'voucher_not_found', 'Voucher not found');

    const [receipt, labels] = await Promise.all([
      prisma.receipt.findUnique({ where: { voucherId: id } }),
      serviceLabels([v]),
    ]);
    return { ...serialise(v, labels), receipt };
  });
}

/**
 * Yields the CSV one line at a time. Rows are paged by voucher id, which is
 * unique and ordered, so a batch boundary can never skip or duplicate a row.
 */
async function* voucherCsv(where: Prisma.VoucherWhereInput): AsyncGenerator<string> {
  yield `${csvRow(CSV_COLUMNS)}\r\n`;

  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.voucher.findMany({
      where,
      include: { provider: true },
      // Numeric id order (#61), with the string id as the final tie-break so
      // the batch boundary below always lands on a deterministic total order.
      orderBy: idOrder('asc'),
      take: CSV_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (batch.length === 0) return;

    const labels = await serviceLabels(batch);
    for (const v of batch) {
      yield `${csvRow([
        v.id,
        v.funder,
        v.providerAddress,
        v.provider.name,
        v.provider.country,
        v.serviceCode,
        labels.get(serviceKey(v.providerAddress, v.serviceCode)) ?? null,
        v.amount,
        fromBaseUnits(v.amount),
        v.status,
        v.createdAt,
        v.expiresAt,
        v.claimedAt,
        v.attestedAt,
        v.disputeDeadline,
        v.disputeReason,
        v.settledNet,
        v.settledFee,
        refundableAt(v),
        isSettleable(v),
        isRefundable(v),
      ])}\r\n`;
    }

    if (batch.length < CSV_BATCH_SIZE) return;
    cursor = batch[batch.length - 1]!.id;
  }
}

/** The common path: filter, count and page entirely in the database. */
async function pageByWhere(
  where: Prisma.VoucherWhereInput,
  sort: 'createdAt' | 'expiresAt',
  order: 'asc' | 'desc',
  limit: number,
  offset: number,
): Promise<{ rows: Row[]; total: number }> {
  const primary = sort === 'createdAt' ? { createdAt: order } : { expiresAt: order };
  const [rows, total] = await Promise.all([
    prisma.voucher.findMany({
      where,
      include: { provider: true },
      // Sorted by `seq`, the numeric voucher id, not `id`: string order
      // would put voucher 10 before voucher 9 (#61).
      orderBy: [primary, ...idOrder(order)],
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
  sort: 'createdAt' | 'expiresAt' | 'amount',
  order: 'asc' | 'desc',
  limit: number,
  offset: number,
): Promise<{ rows: Row[]; total: number }> {
  const candidates = await prisma.voucher.findMany({
    where,
    orderBy:
      sort === 'amount'
        ? { createdAt: 'desc' }
        : [
            sort === 'createdAt' ? { createdAt: order } : { expiresAt: order },
            ...idOrder(order),
          ],
    select: { id: true, amount: true },
  });

  const matching = candidates.filter((c) => {
    const amount = BigInt(c.amount);
    return (min === null || amount >= min) && (max === null || amount <= max);
  });
  if (sort === 'amount') matching.sort((a, b) => compareAmount(a, b, order));

  const ids = matching.slice(offset, offset + limit).map((c) => c.id);
  if (ids.length === 0) return { rows: [], total: matching.length };

  const rows = await prisma.voucher.findMany({
    where: { id: { in: ids } },
    include: { provider: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows: ids.map((id) => byId.get(id)!), total: matching.length };
}

function parseWithin(within: string, now: number): number {
  const match = within.match(/^(\d+)([hmd])$/);
  if (!match) return now;
  const value = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'm':
      return now + value * 60 * 1000;
    case 'h':
      return now + value * 60 * 60 * 1000;
    case 'd':
      return now + value * 24 * 60 * 60 * 1000;
    default:
      return now;
  }
}

function compareAmount(
  a: { id: string; amount: string },
  b: { id: string; amount: string },
  order: 'asc' | 'desc',
): number {
  const av = BigInt(a.amount);
  const bv = BigInt(b.amount);
  const sign = order === 'asc' ? 1 : -1;
  if (av !== bv) return av < bv ? -sign : sign;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -sign : sign;
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
