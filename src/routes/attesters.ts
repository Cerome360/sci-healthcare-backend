import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';

const listQuery = z.object({
  // `?all=true` includes removed attesters; the default is only those who
  // can attest today.
  all: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

type AttesterRow = {
  address: string;
  active: boolean;
  addedAt: Date;
  removedAt: Date | null;
};

function serialise(a: AttesterRow, attestations: number) {
  return {
    address: a.address,
    active: a.active,
    addedAt: a.addedAt,
    removedAt: a.removedAt,
    attestations,
  };
}

/**
 * How many vouchers each attester has confirmed, in one query.
 *
 * Funders are asked to trust attesters, and "how much has this attester
 * confirmed" is the number that makes that trust checkable.
 */
async function attestationCounts(addresses: string[]): Promise<Map<string, number>> {
  if (addresses.length === 0) return new Map();

  const grouped = await prisma.voucher.groupBy({
    by: ['attestedBy'],
    where: { attestedBy: { in: addresses } },
    _count: { _all: true },
  });

  const counts = new Map<string, number>();
  for (const row of grouped) {
    if (row.attestedBy !== null) counts.set(row.attestedBy, row._count._all);
  }
  return counts;
}

/**
 * The attesters trusted to confirm care.
 *
 * By default only active attesters are listed — the set that can attest
 * right now. `?all=true` adds those that were removed, so the roster can
 * be audited over time rather than only as it stands today.
 */
export async function attesterRoutes(app: FastifyInstance): Promise<void> {
  app.get('/attesters', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { all, limit, offset } = parsed.data;

    const where = all ? {} : { active: true };
    const [rows, total] = await Promise.all([
      prisma.attester.findMany({
        where,
        orderBy: [{ active: 'desc' }, { addedAt: 'desc' }],
        take: limit,
        skip: offset,
      }),
      prisma.attester.count({ where }),
    ]);

    const counts = await attestationCounts(rows.map((r) => r.address));
    return {
      total,
      limit,
      offset,
      attesters: rows.map((a) => serialise(a, counts.get(a.address) ?? 0)),
    };
  });

  app.get('/attesters/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    const attester = await prisma.attester.findUnique({ where: { address } });
    if (!attester) return reply.code(404).send({ error: 'attester_not_found' });

    const attestations = await prisma.voucher.count({ where: { attestedBy: address } });
    return serialise(attester, attestations);
  });
}
