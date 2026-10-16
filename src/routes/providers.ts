import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { fromBaseUnits } from '../lib/amounts.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';

const listQuery = z.object({
  status: z.enum(['Pending', 'Active', 'Suspended']).optional(),
  country: z.string().length(2).optional(),
  q: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/providers', { config: { rateLimit: LIST_ROUTE_RATE_LIMIT } }, async (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { status, country, q, limit, offset } = parsed.data;

    const where = {
      ...(status ? { status } : {}),
      ...(country ? { country } : {}),
      ...(q ? { name: { contains: q } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.provider.findMany({
        where,
        include: { services: { where: { active: true } } },
        orderBy: { registeredAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.provider.count({ where }),
    ]);

    return {
      total,
      limit,
      offset,
      providers: rows.map((p) => ({
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
      })),
    };
  });

  app.get('/providers/:address', async (req, reply) => {
    const { address } = req.params as { address: string };
    const p = await prisma.provider.findUnique({
      where: { address },
      include: { services: true },
    });
    if (!p) return reply.code(404).send({ error: 'provider_not_found' });

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
}
