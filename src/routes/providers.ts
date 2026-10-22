import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { isPostgres } from '../lib/database.js';
import { cursorParam, decodeCursor, encodeCursor, limitParam } from '../lib/cursor.js';
import { ApiError } from '../lib/errors.js';
import { applyFields, parseFields } from '../lib/fields.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';

const listQuery = z.object({
  status: z.enum(['Pending', 'Active', 'Suspended']).optional(),
  country: z.string().length(2).optional(),
  q: z.string().min(1).max(64).optional(),
  cursor: cursorParam,
  limit: limitParam,
  offset: z.coerce.number().int().min(0).default(0),
  fields: z.string().max(512).optional(),
});

/** Top-level keys the provider list items emit: the allow-list for `?fields=` (#166). */
const PROVIDER_FIELDS = [
  'address',
  'name',
  'country',
  'status',
  'registeredAt',
  'services',
] as const;

/** Every voucher status, in the order the contract moves through them. */
const VOUCHER_STATUSES = [
  'Funded',
  'Claimed',
  'Attested',
  'Settled',
  'Disputed',
  'Refunded',
] as const;

const providerStatsResponse = z.object({
  address: z.string(),
  name: z.string(),
  status: z.string(),
  vouchers: z.number().int().nonnegative(),
  byStatus: z.record(z.number().int().nonnegative()),
  settledVouchers: z.number().int().nonnegative(),
  settledValue: z.string().describe('Total settled amount as a base-unit decimal string.'),
  settledValueDisplay: z.string(),
  medianClaimSeconds: z.number().nonnegative().nullable().describe(
    'Median seconds from voucher creation to claim (claimedAt - createdAt). ' +
    'Only complete, non-negative intervals for this provider are included, regardless of current status. ' +
    'Null when none exist; even sample counts average the middle two without rounding.',
  ),
  medianAttestationSeconds: z.number().nonnegative().nullable().describe(
    'Median seconds from claim to attestation (attestedAt - claimedAt). ' +
    'Only complete, non-negative intervals for this provider are included, regardless of current status. ' +
    'Null when none exist; even sample counts average the middle two without rounding.',
  ),
});

const providerStatsResponses = {
  200: providerStatsResponse,
  404: z.object({ error: z.literal('provider_not_found') }),
};

/** Numeric median; keep fractional seconds when averaging an even sample. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]!
    : (values[middle - 1]! + values[middle]!) / 2;
}

/** Case-insensitive on Postgres; SQLite's LIKE is already case-insensitive for ASCII. */
function nameContains(q: string): { contains: string; mode?: string } {
  const filter: { contains: string; mode?: string } = { contains: q };
  if (isPostgres) filter.mode = 'insensitive';
  return filter;
}

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/providers', { config: { rateLimit: LIST_ROUTE_RATE_LIMIT } }, async (req) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
    }
    const { status, country, q, cursor, limit, offset, fields } = parsed.data;

    const fieldSet = parseFields(fields, PROVIDER_FIELDS, 'GET /providers');
    const project = <T extends Record<string, unknown>>(rows: T[]): Partial<T>[] =>
      fieldSet ? rows.map((r) => applyFields(r, fieldSet)) : rows;

    const formatProvider = (p: {
      address: string;
      name: string;
      country: string;
      status: string;
      registeredAt: Date;
      services: { code: number; label: string; price: string }[];
    }) => ({
      address: p.address,
      name: p.name,
      country: p.country,
      status: p.status,
      registeredAt: p.registeredAt,
      services: p.services.map((s) => ({
        code: s.code,
        label: s.label,
        price: s.price,
        priceDisplay: fromBaseUnits(s.price),
      })),
    });

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
      }
      const cursorDate = new Date(decoded.createdAt);
      const where = {
        ...(status ? { status } : {}),
        ...(country ? { country } : {}),
        ...(q ? { name: nameContains(q) } : {}),
        OR: [
          { registeredAt: { lt: cursorDate } },
          { registeredAt: cursorDate, address: { lt: decoded.id } },
        ],
      };
      const rows = await prisma.provider.findMany({
        where,
        include: { services: { where: { active: true } } },
        orderBy: [{ registeredAt: 'desc' }, { address: 'desc' }],
        take: limit + 1,
      });
      const hasNext = rows.length > limit;
      const page = hasNext ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor = hasNext && last ? encodeCursor(last.registeredAt, last.address) : null;
      return { limit, nextCursor, providers: project(page.map(formatProvider)) };
    }

    const where = {
      ...(status ? { status } : {}),
      ...(country ? { country } : {}),
      ...(q ? { name: nameContains(q) } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.provider.findMany({
        where,
        include: { services: { where: { active: true } } },
        orderBy: [{ registeredAt: 'desc' }, { address: 'desc' }],
        take: limit + 1,
        skip: offset,
      }),
      prisma.provider.count({ where }),
    ]);

    const hasNext = rows.length > limit;
    const page = hasNext ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasNext && last ? encodeCursor(last.registeredAt, last.address) : undefined;

    return { total, limit, offset, nextCursor, providers: project(page.map(formatProvider)) };
  });

  app.get('/providers/:address', async (req) => {
    const { address } = req.params as { address: string };
    const p = await prisma.provider.findUnique({
      where: { address },
      include: { services: true },
    });
    if (!p) throw new ApiError(404, 'provider_not_found', 'Provider not found');

    return {
      address: p.address,
      name: p.name,
      country: p.country,
      status: p.status,
      registeredAt: p.registeredAt,
      services: p.services.map((s) => ({
        code: s.code,
        label: s.label,
        price: s.price,
        priceDisplay: fromBaseUnits(s.price),
        active: s.active,
      })),
    };
  });

  /**
   * A clinic's own throughput: how many vouchers it received, in what state,
   * the total value it settled, and its observed response times.
   *
   * A funder choosing between clinics wants evidence one actually delivers
   * care, and a clinic desk wants its own numbers. Amounts are summed with
   * BigInt and returned as base-unit decimal strings, like everywhere else.
   */
  app.get('/providers/:address/stats', {
    schema: {
      tags: ['providers'],
      summary: 'Clinic throughput and response times',
      response: providerStatsResponses,
    },
    config: {
      // The global Zod transform targets OpenAPI 3.0, where nullable is a
      // keyword. This API advertises 3.1, so describe null as a schema type.
      swaggerTransform: ({ schema, url }) => ({
        schema: {
          ...schema,
          response: Object.fromEntries(Object.entries(providerStatsResponses).map(
            ([status, response]) => [status, zodToJsonSchema(response, {
              target: 'jsonSchema7',
              $refStrategy: 'none',
            })],
          )),
        },
        url,
      }),
    },
  }, async (req, reply) => {
    const { address } = req.params as { address: string };
    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true, name: true, status: true },
    });
    if (!provider) return reply.code(404).send({ error: 'provider_not_found' });

    const [grouped, settled, timings] = await Promise.all([
      prisma.voucher.groupBy({
        by: ['status'],
        where: { providerAddress: address },
        _count: { _all: true },
      }),
      prisma.voucher.findMany({
        where: { providerAddress: address, status: 'Settled' },
        select: { amount: true },
      }),
      prisma.voucher.findMany({
        where: { providerAddress: address, claimedAt: { not: null } },
        select: { createdAt: true, claimedAt: true, attestedAt: true },
      }),
    ]);

    // Every status is present, zero included, so a client can render the
    // full breakdown without filling gaps itself.
    const byStatus: Record<string, number> = Object.fromEntries(
      VOUCHER_STATUSES.map((status) => [status, 0]),
    );
    let vouchers = 0;
    for (const row of grouped) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row._count._all;
      vouchers += row._count._all;
    }

    const settledValue = settled
      .reduce((acc, v) => acc + BigInt(v.amount), 0n)
      .toString();

    // Measure each completed stage independently, including vouchers that
    // have since settled, been disputed or refunded. A missing timestamp
    // is not zero; reversed timestamps are not valid response times.
    const claimSeconds: number[] = [];
    const attestationSeconds: number[] = [];
    for (const v of timings) {
      const claimedAt = v.claimedAt!.getTime(); // guaranteed by the query
      const claim = (claimedAt - v.createdAt.getTime()) / 1000;
      if (claim >= 0) claimSeconds.push(claim);
      if (v.attestedAt !== null) {
        const attestation = (v.attestedAt.getTime() - claimedAt) / 1000;
        if (attestation >= 0) attestationSeconds.push(attestation);
      }
    }

    return {
      address: provider.address,
      name: provider.name,
      status: provider.status,
      vouchers,
      byStatus,
      settledVouchers: settled.length,
      settledValue,
      settledValueDisplay: fromBaseUnits(settledValue),
      medianClaimSeconds: median(claimSeconds),
      medianAttestationSeconds: median(attestationSeconds),
    };
  });

  /**
   * Every status transition observed for a clinic, oldest first.
   *
   * A clinic suspended twice a year reads very differently from one never
   * suspended, and the current status alone cannot tell them apart.
   */
  app.get('/providers/:address/history', async (req) => {
    const { address } = req.params as { address: string };
    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!provider) throw new ApiError(404, 'provider_not_found', 'Provider not found');

    const changes = await prisma.providerStatusChange.findMany({
      where: { providerAddress: address },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    return {
      address,
      history: changes.map((c) => ({
        status: c.status,
        ledger: c.ledger,
        changedAt: c.changedAt,
      })),
    };
  });

  /** Every observed price for one service, oldest first. */
  app.get('/providers/:address/services/:code/history', async (req) => {
    const { address, code } = req.params as { address: string; code: string };
    const serviceCode = Number(code);
    if (!Number.isInteger(serviceCode) || serviceCode < 0) {
      throw new ApiError(400, 'invalid_code', 'code must be a non-negative integer');
    }

    const provider = await prisma.provider.findUnique({
      where: { address },
      select: { address: true },
    });
    if (!provider) throw new ApiError(404, 'provider_not_found', 'Provider not found');

    const changes = await prisma.servicePriceChange.findMany({
      where: { providerAddress: address, code: serviceCode },
      orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    });

    return {
      providerAddress: address,
      code: serviceCode,
      history: changes.map((c) => ({
        price: c.price,
        priceDisplay: fromBaseUnits(c.price),
        ledger: c.ledger,
        changedAt: c.changedAt,
      })),
    };
  });

  app.get('/countries', async () => {
    const grouped = await prisma.provider.groupBy({
      by: ['country'],
      where: { status: 'Active' },
      _count: { _all: true },
    });

    return {
      countries: grouped
        .map((g) => ({ code: g.country, clinicCount: g._count._all }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    };
  });
}