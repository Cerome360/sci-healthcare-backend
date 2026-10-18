import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isValidRef } from '../lib/beneficiary.js';
import { cursorParam, decodeCursor, encodeCursor, limitParam } from '../lib/cursor.js';
import { ApiError } from '../lib/errors.js';
import { providerSummaries, type ProviderSummary } from '../lib/providers.js';
import { serviceKey, serviceLabels } from '../lib/services.js';

const listQuery = z
  .object({
    beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters').optional(),
    provider: z.string().length(56).optional(),
    cursor: cursorParam,
    limit: limitParam,
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((data) => Boolean(data.beneficiaryRef) !== Boolean(data.provider), {
    message: 'Provide exactly one of: beneficiaryRef, provider',
    path: ['beneficiaryRef', 'provider'],
  });

const voucherIdParam = z.object({
  voucherId: z.string().min(1),
});

const summaryQuery = z.object({
  beneficiaryRef: z.string().refine(isValidRef, 'must be 64 hex characters'),
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
    const { beneficiaryRef, provider, cursor, limit, offset } = parsed.data;

    const baseWhere = beneficiaryRef
      ? { beneficiaryRef }
      : { providerAddress: provider! };

    const isProviderView = Boolean(provider);

    const formatReceipt = (
      r: {
        voucherId: string;
        providerAddress: string;
        serviceCode: number;
        amount: string;
        settledAt: Date;
        beneficiaryRef: string;
      },
      labels: Map<string, string>,
      clinics: Map<string, ProviderSummary>,
    ) => {
      // The chain only records an address. The clinic row is what turns it
      // into the name a patient recognises, resolved for the whole page in
      // one query by `providerSummaries` rather than row by row. A clinic the
      // indexer never saw registered keeps its address and reports the name
      // and country as unknown rather than guessed.
      const clinic = clinics.get(r.providerAddress);
      return {
        voucherId: r.voucherId,
        providerAddress: r.providerAddress,
        provider: {
          address: r.providerAddress,
          name: clinic?.name ?? null,
          country: clinic?.country ?? null,
        },
        serviceCode: r.serviceCode,
        serviceLabel: labels.get(serviceKey(r.providerAddress, r.serviceCode)) ?? null,
        amount: r.amount,
        amountDisplay: fromBaseUnits(r.amount),
        settledAt: r.settledAt,
        ...(isProviderView ? {} : { beneficiaryRef: r.beneficiaryRef }),
      };
    };

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
      }
      const cursorDate = new Date(decoded.createdAt);
      const where = {
        ...baseWhere,
        OR: [
          { settledAt: { lt: cursorDate } },
          { settledAt: cursorDate, voucherId: { lt: decoded.id } },
        ],
      };
      const rows = await prisma.receipt.findMany({
        where,
        orderBy: [{ settledAt: 'desc' }, { voucherId: 'desc' }],
        take: limit + 1,
      });
      const hasNext = rows.length > limit;
      const page = hasNext ? rows.slice(0, limit) : rows;
      const [labels, clinics] = await Promise.all([
        serviceLabels(page),
        providerSummaries(page),
      ]);
      const last = page[page.length - 1];
      const nextCursor = hasNext && last ? encodeCursor(last.settledAt, last.voucherId) : null;
      return { limit, nextCursor, receipts: page.map((r) => formatReceipt(r, labels, clinics)) };
    }

    const [rows, total, spend] = await Promise.all([
      prisma.receipt.findMany({
        where: baseWhere,
        orderBy: [{ settledAt: 'desc' }, { voucherId: 'desc' }],
        take: limit + 1,
        skip: offset,
      }),
      prisma.receipt.count({ where: baseWhere }),
      prisma.receipt.findMany({
        where: baseWhere,
        select: { amount: true },
      }),
    ]);

    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const [labels, clinics] = await Promise.all([
      serviceLabels(page),
      providerSummaries(page),
    ]);
    const last = page[page.length - 1];
    const nextCursor = hasNext && last ? encodeCursor(last.settledAt, last.voucherId) : undefined;
    const totalSpend = spend
      .reduce((acc, r) => acc + BigInt(r.amount), 0n)
      .toString();

    return {
      total,
      limit,
      offset,
      nextCursor,
      totalSpend,
      totalSpendDisplay: fromBaseUnits(totalSpend),
      receipts: page.map((r) => formatReceipt(r, labels, clinics)),
    };
  });

  /**
   * Care summary for one patient reference (#53).
   *
   * The care history page otherwise fetches every receipt and sums them on
   * the client. This answers count, total spend, first and last visit and
   * the clinics visited in one call, from the same rows `GET /receipts`
   * serves.
   *
   * It is patient-view only: a provider-wide summary would aggregate many
   * patients into one number, and a clinic already has its own list. The
   * response never echoes the beneficiary reference back — the caller must
   * already know it to ask — and clinic entries carry only public registry
   * fields, matching `GET /receipts` (#51).
   */
  app.get('/receipts/summary', async (req) => {
    const parsed = summaryQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { beneficiaryRef } = parsed.data;

    const rows = await prisma.receipt.findMany({
      where: { beneficiaryRef },
      select: { providerAddress: true, amount: true, settledAt: true },
    });

    // Amounts are i128 strings; the running sums stay in BigInt throughout,
    // exactly as `totalSpend` on GET /receipts does.
    let total = 0n;
    let firstVisit: Date | null = null;
    let lastVisit: Date | null = null;
    const byClinic = new Map<string, { visits: number; spend: bigint }>();
    for (const r of rows) {
      const amount = BigInt(r.amount);
      total += amount;
      if (firstVisit === null || r.settledAt < firstVisit) firstVisit = r.settledAt;
      if (lastVisit === null || r.settledAt > lastVisit) lastVisit = r.settledAt;
      const clinic = byClinic.get(r.providerAddress) ?? { visits: 0, spend: 0n };
      clinic.visits += 1;
      clinic.spend += amount;
      byClinic.set(r.providerAddress, clinic);
    }

    // One batched lookup names every visited clinic; an address the indexer
    // never saw registered reports null rather than a guessed name.
    const clinics = await providerSummaries(
      [...byClinic.keys()].map((address) => ({ providerAddress: address })),
    );
    // Sorted by address so two calls render identically regardless of the
    // order receipts happen to be read in.
    const clinicList = [...byClinic.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([address, agg]) => {
        const clinic = clinics.get(address);
        const spend = agg.spend.toString();
        return {
          address,
          name: clinic?.name ?? null,
          country: clinic?.country ?? null,
          visits: agg.visits,
          spend,
          spendDisplay: fromBaseUnits(spend),
        };
      });

    const totalStr = total.toString();
    return {
      count: rows.length,
      total: totalStr,
      totalDisplay: fromBaseUnits(totalStr),
      firstVisit,
      lastVisit,
      clinics: clinicList,
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

    const [labels, clinics] = await Promise.all([
      serviceLabels([receipt]),
      providerSummaries([receipt]),
    ]);
    // The clinic behind the address, so a shareable receipt page can show
    // where it was issued. `GET /vouchers/:id` already returns this shape.
    const clinic = clinics.get(receipt.providerAddress);
    return {
      voucherId: receipt.voucherId,
      providerAddress: receipt.providerAddress,
      provider: {
        address: receipt.providerAddress,
        name: clinic?.name ?? null,
        country: clinic?.country ?? null,
      },
      serviceCode: receipt.serviceCode,
      serviceLabel: labels.get(serviceKey(receipt.providerAddress, receipt.serviceCode)) ?? null,
      amount: receipt.amount,
      amountDisplay: fromBaseUnits(receipt.amount),
      settledAt: receipt.settledAt,
    };
  });
}
