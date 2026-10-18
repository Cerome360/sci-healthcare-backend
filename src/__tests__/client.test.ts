import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { seedLocalData } from '../scripts/seed.js';
import { ApiError, createClient, providerLocation, type Provider } from '../../packages/client/dist/index.js';

describe('@sci-healthcare/client', () => {
  let app: FastifyInstance;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();

    await prisma.faucetDrip.deleteMany();
    await prisma.receipt.deleteMany();
    await prisma.voucher.deleteMany();
    await prisma.service.deleteMany();
    await prisma.provider.deleteMany();
    await prisma.governanceEvent.deleteMany();
    await prisma.servicePriceChange.deleteMany();
    await seedLocalData(prisma);

    // Adapter connecting the typed client to app.inject without opening network sockets
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      );
      const method = (init?.method ?? 'GET') as
        | 'GET'
        | 'POST'
        | 'PUT'
        | 'DELETE'
        | 'OPTIONS'
        | 'HEAD'
        | 'PATCH';

      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (Array.isArray(init.headers)) {
          for (const entry of init.headers) {
            const [k, v] = entry as [string, string];
            if (k) headers[k] = v;
          }
        } else if (typeof (init.headers as { forEach?: unknown }).forEach === 'function') {
          (init.headers as { forEach: (cb: (v: string, k: string) => void) => void }).forEach(
            (v: string, k: string) => {
              headers[k] = v;
            },
          );
        } else {
          Object.assign(headers, init.headers);
        }
      }

      const res = await app.inject({
        method,
        url: url.pathname + url.search,
        headers,
        ...(init?.body ? { payload: String(init.body) } : {}),
      });

      return new Response(res.body, {
        status: res.statusCode,
        statusText: res.statusMessage,
      });
    };

    client = createClient({
      baseUrl: 'http://localhost:3000',
      fetch: fetchImpl,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('queries health and version information', async () => {
    const health = await client.health();
    expect(health).toEqual({ status: 'ok' });

    const version = await client.version();
    expect(version.version).toBeDefined();
    expect(version.network).toBeDefined();
    expect(version.contracts.registry).toBeDefined();
  });

  it('queries aggregate stats', async () => {
    const stats = await client.stats();
    expect(stats.providers).toBeGreaterThan(0);
    expect(stats.vouchers).toBeGreaterThan(0);
    expect(typeof stats.settledValue).toBe('string');
  });

  it('queries providers list and single provider', async () => {
    const res = await client.providers({ status: 'Active' });
    expect(res.total).toBeGreaterThan(0);
    expect(res.providers.length).toBeGreaterThan(0);

    const first = res.providers[0]!;
    const provider = await client.provider(first.address);
    expect(provider.address).toBe(first.address);
    expect(provider.name).toBe(first.name);
  });

  it('queries services catalogue and single service by code', async () => {
    const res = await client.services();
    expect(res.total).toBeGreaterThan(0);
    expect(res.services.length).toBeGreaterThan(0);

    const first = res.services[0]!;
    const detail = await client.service(first.code);
    expect(detail.code).toBe(first.code);
    expect(detail.clinicCount).toBeGreaterThan(0);
  });

  it('queries vouchers with filters', async () => {
    const res = await client.vouchers({ status: ['Funded', 'Claimed'] });
    expect(res.vouchers.length).toBeGreaterThan(0);
    const first = res.vouchers[0]!;

    const detail = await client.voucher(first.id);
    expect(detail.id).toBe(first.id);
    expect(detail.funder).toBe(first.funder);
    expect(detail.isSettleable).toBeDefined();
  });

  it('queries governance contracts and audit history', async () => {
    const res = await client.governance();
    expect(res.contracts).toBeDefined();
    expect(Array.isArray(res.contracts)).toBe(true);
  });

  it('queries countries list', async () => {
    const res = await client.countries();
    expect(res.countries).toBeDefined();
    expect(res.countries.length).toBeGreaterThan(0);
  });

  it('throws typed ApiError on validation failures', async () => {
    await expect(
      client.vouchers({ minAmount: '100', maxAmount: '50' }),
    ).rejects.toThrow(ApiError);

    try {
      await client.vouchers({ minAmount: '100', maxAmount: '50' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.error).toBe('invalid_query');
      expect(apiErr.issues).toBeDefined();
    }
  });

  it('throws ApiError on 404', async () => {
    await expect(
      client.provider('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ).rejects.toThrow(ApiError);
  });

  it('validates providerLocation helper accurately', () => {
    const valid: Provider = {
      address: 'GABC',
      name: 'Test Clinic',
      country: 'KE',
      status: 'Active',
      registeredAt: new Date().toISOString(),
      services: [],
      location: { lat: -1.286389, lng: 36.817223 },
    };
    expect(providerLocation(valid)).toEqual({ lat: -1.286389, lng: 36.817223 });

    const metadataLocation: Provider = {
      address: 'GABC',
      name: 'Test Clinic',
      country: 'KE',
      status: 'Active',
      registeredAt: new Date().toISOString(),
      services: [],
      metadata: { location: { lat: 0.5, lng: 35.2 } },
    };
    expect(providerLocation(metadataLocation)).toEqual({ lat: 0.5, lng: 35.2 });

    const invalidLat: Provider = {
      ...valid,
      location: { lat: 100, lng: 10 },
    };
    expect(providerLocation(invalidLat)).toBeNull();

    const noLocation: Provider = {
      ...valid,
      location: null,
      metadata: null,
    };
    expect(providerLocation(noLocation)).toBeNull();
  });
});
