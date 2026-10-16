import type { rpc } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { collectEvents, type EventSource } from '../stellar/paging.js';

const CONTRACT = 'CAMO4ITIU22HSBO2WGV4MQSSKOE3EOVUEJOVYLBYPFW32VYZOTJ2XE7N';
const LATEST = 5_000;

/**
 * A fake RPC holding `ledgers[i]` events in ledger `i + 1`, served in
 * pages exactly as Soroban RPC does: by `startLedger` on the first call,
 * then by the opaque cursor it returned.
 */
function fakeRpc(perLedger: number[]) {
  const all = perLedger.flatMap((count, i) =>
    Array.from({ length: count }, (_, j) => ({ id: `${i + 1}-${j}`, ledger: i + 1 })),
  );
  const calls: rpc.Api.GetEventsRequest[] = [];

  const source: EventSource = {
    async getEvents(req: rpc.Api.GetEventsRequest) {
      calls.push(req);
      const from =
        'cursor' in req && req.cursor !== undefined
          ? Number(req.cursor)
          : all.findIndex((e) => e.ledger >= (req as { startLedger: number }).startLedger);
      const start = from === -1 ? all.length : from;
      const page = all.slice(start, start + (req.limit ?? 100));
      return {
        events: page as unknown as rpc.Api.EventResponse[],
        cursor: String(start + page.length),
        latestLedger: LATEST,
        oldestLedger: 1,
        latestLedgerCloseTime: '0',
        oldestLedgerCloseTime: '0',
      } as rpc.Api.GetEventsResponse;
    },
  };
  return { source, calls };
}

describe('collectEvents', () => {
  it('returns a short single page and advances to the tip', async () => {
    const { source, calls } = fakeRpc([3, 2]);
    const out = await collectEvents(source, {
      startLedger: 1,
      contractIds: [CONTRACT],
      pageSize: 10,
    });
    expect(out.events).toHaveLength(5);
    expect(out.throughLedger).toBe(LATEST);
    expect(calls).toHaveLength(1);
  });

  /**
   * Regression test: the indexer used to read one page of 200 events and
   * then advance its cursor to the RPC tip, silently dropping every event
   * past the first page.
   */
  it('follows the cursor until the range is drained', async () => {
    const { source, calls } = fakeRpc([4, 4, 4, 1]);
    const out = await collectEvents(source, {
      startLedger: 1,
      contractIds: [CONTRACT],
      pageSize: 5,
    });
    expect(out.events.map((e) => e.id)).toHaveLength(13);
    expect(new Set(out.events.map((e) => e.id)).size).toBe(13);
    expect(out.throughLedger).toBe(LATEST);
    expect(calls[0]).toMatchObject({ startLedger: 1 });
    expect(calls.slice(1).every((c) => 'cursor' in c && !('startLedger' in c))).toBe(true);
  });

  it('makes one extra call when the last page is exactly full', async () => {
    const { source, calls } = fakeRpc([5]);
    const out = await collectEvents(source, {
      startLedger: 1,
      contractIds: [CONTRACT],
      pageSize: 5,
    });
    expect(out.events).toHaveLength(5);
    expect(calls).toHaveLength(2);
  });

  it('stops before a ledger split across the page cap', async () => {
    // Ledger 2 has events on both sides of the 2-page, 3-per-page cap.
    const { source } = fakeRpc([2, 6, 1]);
    const out = await collectEvents(source, {
      startLedger: 1,
      contractIds: [CONTRACT],
      pageSize: 3,
      maxPages: 2,
    });
    expect(out.events.every((e) => e.ledger === 1)).toBe(true);
    expect(out.events).toHaveLength(2);
    expect(out.throughLedger).toBe(1);
  });

  it('refuses to spin on a single ledger larger than the cap', async () => {
    const { source } = fakeRpc([10]);
    await expect(
      collectEvents(source, {
        startLedger: 1,
        contractIds: [CONTRACT],
        pageSize: 3,
        maxPages: 2,
      }),
    ).rejects.toThrow(/more than 6 indexed events/);
  });

  it('returns nothing and advances when there are no events', async () => {
    const { source } = fakeRpc([]);
    const out = await collectEvents(source, {
      startLedger: 1,
      contractIds: [CONTRACT],
    });
    expect(out.events).toEqual([]);
    expect(out.throughLedger).toBe(LATEST);
    expect(out.hasMore).toBe(false);
  });

  it('signals there is more to fetch when it stops at the page cap', async () => {
    const { source } = fakeRpc([2, 6, 1]);
    const out = await collectEvents(source, {
      startLedger: 1,
      contractIds: [CONTRACT],
      pageSize: 3,
      maxPages: 2,
    });
    expect(out.hasMore).toBe(true);
  });

  it('signals the range is drained on a short page', async () => {
    const { source } = fakeRpc([3, 2]);
    const out = await collectEvents(source, {
      startLedger: 1,
      contractIds: [CONTRACT],
      pageSize: 10,
    });
    expect(out.hasMore).toBe(false);
  });
});
