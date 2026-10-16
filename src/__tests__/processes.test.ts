import type { FastifyBaseLogger } from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { start as startApi } from '../api.js';
import { prisma } from '../db.js';
import { start as startWorker } from '../worker.js';

afterAll(async () => {
  await prisma.$disconnect();
});

describe('separate API and indexer processes', () => {
  it('serves the API on its own, with no indexer running', async () => {
    const app = await startApi({ port: 0, host: '127.0.0.1' });
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });

  it('starts and stops the indexer on its own, with no API', async () => {
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: 100 },
      update: { lastLedger: 100, leaseOwner: null, leaseExpiresAt: null },
    });
    const info = vi.fn();
    const log = {
      info,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as FastifyBaseLogger;

    const indexer = await startWorker({ logger: log });
    try {
      expect(info).toHaveBeenCalledWith(
        { network: 'testnet' },
        'sci-healthcare indexer running',
      );
    } finally {
      await indexer.stop();
    }
  });
});
