import type { rpc } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { parseRpcUrls, redactRpcUrl } from '../env.js';
import { FailoverRpcServer, RpcPool, type RpcPoolOptions } from '../stellar/rpc-pool.js';
import { collectEvents } from '../stellar/paging.js';

const A = 'https://rpc-a.example.org';
const B = 'https://rpc-b.example.org';

/**
 * A stand-in for `rpc.Server` that either fails or answers.
 *
 * Only the methods the pool forwards are implemented; the cast keeps the
 * fake honest about which of them a test actually exercises.
 */
function fakeServer(url: string, behaviour: { failing: boolean; ledger?: number }) {
  const calls = { getLatestLedger: 0, getEvents: 0 };
  const server = {
    url,
    calls,
    behaviour,
    async getLatestLedger() {
      calls.getLatestLedger += 1;
      if (behaviour.failing) throw new Error(`${url} is down`);
      return { sequence: behaviour.ledger ?? 100 };
    },
    async getEvents() {
      calls.getEvents += 1;
      if (behaviour.failing) throw new Error(`${url} is down`);
      return {
        events: [{ id: `event-from-${url}`, ledger: 7 }],
        latestLedger: behaviour.ledger ?? 100,
        cursor: '',
      };
    },
  };
  return server;
}

function poolOf(
  servers: ReturnType<typeof fakeServer>[],
  opts: Omit<RpcPoolOptions, 'factory'> = {},
) {
  const byUrl = new Map(servers.map((s) => [s.url, s]));
  return new RpcPool(
    servers.map((s) => s.url),
    {
      maxFailures: opts.maxFailures ?? 3,
      log: { info: vi.fn(), warn: vi.fn() },
      factory: (url) => byUrl.get(url) as unknown as rpc.Server,
      ...opts,
    },
  );
}

describe('parseRpcUrls', () => {
  it('prefers the list and keeps its order', () => {
    expect(parseRpcUrls(`${A}, ${B}`, 'https://ignored.example.org')).toEqual([A, B]);
  });

  it('falls back to the single-endpoint variable', () => {
    expect(parseRpcUrls(undefined, A)).toEqual([A]);
  });

  it('drops blanks and duplicates so rotation cannot land back on the same endpoint', () => {
    expect(parseRpcUrls(`${A}, ,${A},${B},`, undefined)).toEqual([A, B]);
  });

  it('returns nothing when neither variable is set', () => {
    expect(parseRpcUrls(undefined, undefined)).toEqual([]);
    expect(parseRpcUrls('  ', '')).toEqual([]);
  });

  it('rejects a value that is not a URL rather than failing on the first call', () => {
    expect(() => parseRpcUrls('not-a-url', undefined)).toThrow(/invalid URL/i);
  });
});

describe('redactRpcUrl', () => {
  it('hides credentials', () => {
    expect(redactRpcUrl('https://user:secret@rpc.example.org')).toBe(
      'https://***@rpc.example.org',
    );
  });

  it('leaves a plain URL alone', () => {
    expect(redactRpcUrl(A)).toBe(A);
  });
});

describe('RpcPool', () => {
  it('needs at least one endpoint', () => {
    expect(() => new RpcPool([])).toThrow(/at least one/i);
  });

  it('stays on the first endpoint while it answers', async () => {
    const a = fakeServer(A, { failing: false, ledger: 11 });
    const b = fakeServer(B, { failing: false, ledger: 22 });
    const pool = poolOf([a, b]);

    for (let i = 0; i < 5; i++) {
      await expect(pool.run((s) => s.getLatestLedger())).resolves.toMatchObject({ sequence: 11 });
    }
    expect(b.calls.getLatestLedger).toBe(0);
    expect(pool.activeUrl).toBe(A);
  });

  it('tolerates a blip without switching', async () => {
    const a = fakeServer(A, { failing: true });
    const b = fakeServer(B, { failing: false, ledger: 22 });
    const pool = poolOf([a, b], { maxFailures: 3 });

    await expect(pool.run((s) => s.getLatestLedger())).rejects.toThrow(/rpc-a/);
    expect(pool.activeUrl).toBe(A);
    expect(b.calls.getLatestLedger).toBe(0);
  });

  it('switches to the next endpoint after repeated failures and answers from it', async () => {
    const a = fakeServer(A, { failing: true });
    const b = fakeServer(B, { failing: false, ledger: 22 });
    const log = { info: vi.fn(), warn: vi.fn() };
    const pool = poolOf([a, b], { maxFailures: 2, log });

    // First failure is tolerated...
    await expect(pool.run((s) => s.getLatestLedger())).rejects.toThrow();
    // ...the second reaches the threshold, rotates, and is retried on B.
    await expect(pool.run((s) => s.getLatestLedger())).resolves.toMatchObject({ sequence: 22 });

    expect(pool.activeUrl).toBe(B);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ from: A, active: B }),
      expect.stringContaining('switching'),
    );
  });

  it('resets the streak once an endpoint answers', async () => {
    const a = fakeServer(A, { failing: true });
    const pool = poolOf([a], { maxFailures: 3 });

    await expect(pool.run((s) => s.getLatestLedger())).rejects.toThrow();
    expect(pool.failureStreak).toBe(1);

    a.behaviour.failing = false;
    await pool.run((s) => s.getLatestLedger());
    expect(pool.failureStreak).toBe(0);
  });

  it('tries each endpoint at most once per call when all are down', async () => {
    const a = fakeServer(A, { failing: true });
    const b = fakeServer(B, { failing: true });
    const pool = poolOf([a, b], { maxFailures: 1 });

    await expect(pool.run((s) => s.getLatestLedger())).rejects.toThrow(/is down/);
    expect(a.calls.getLatestLedger).toBe(1);
    expect(b.calls.getLatestLedger).toBe(1);
  });

  it('never rotates when only one endpoint is configured', async () => {
    const a = fakeServer(A, { failing: true });
    const pool = poolOf([a], { maxFailures: 1 });

    for (let i = 0; i < 3; i++) {
      await expect(pool.run((s) => s.getLatestLedger())).rejects.toThrow();
    }
    expect(pool.activeUrl).toBe(A);
    expect(a.calls.getLatestLedger).toBe(3);
  });

  it('redacts credentials in the endpoints it reports', () => {
    const credentialled = 'https://user:secret@rpc-c.example.org';
    const pool = poolOf([fakeServer(credentialled, { failing: false })]);
    expect(pool.activeUrl).toBe('https://***@rpc-c.example.org');
    expect(pool.allUrls).toEqual(['https://***@rpc-c.example.org']);
  });
});

describe('FailoverRpcServer', () => {
  it('serves events from the second endpoint while the first is failing', async () => {
    const a = fakeServer(A, { failing: true });
    const b = fakeServer(B, { failing: false, ledger: 42 });
    const server = new FailoverRpcServer(poolOf([a, b], { maxFailures: 1 }));

    // Driven through the real pager, which is what the indexer calls.
    const collected = await collectEvents(server, {
      startLedger: 1,
      contractIds: ['C'.repeat(56)],
      pageSize: 200,
    });

    expect(collected.events).toEqual([{ id: `event-from-${B}`, ledger: 7 }]);
    expect(collected.throughLedger).toBe(42);
    expect(b.calls.getEvents).toBe(1);
  });

  it('reports which endpoint is active', async () => {
    const a = fakeServer(A, { failing: true });
    const b = fakeServer(B, { failing: false });
    const server = new FailoverRpcServer(poolOf([a, b], { maxFailures: 1 }));

    expect(server.activeUrl).toBe(A);
    await server.getLatestLedger();
    expect(server.activeUrl).toBe(B);
    expect(server.allUrls).toEqual([A, B]);
  });
});
