import type { rpc } from '@stellar/stellar-sdk';

/** The one RPC method the pager needs, so tests can pass a fake. */
export type EventSource = Pick<rpc.Server, 'getEvents'>;

export type CollectedEvents = {
  events: rpc.Api.EventResponse[];
  /**
   * Highest ledger whose events are all in `events`. The caller may
   * persist this as its cursor; nothing at or below it will be missed.
   */
  throughLedger: number;
  /**
   * True when the page budget was exhausted while the range was still
   * producing full pages, so there is almost certainly more to fetch. The
   * caller can use this to poll again immediately instead of sleeping.
   */
  hasMore: boolean;
};

export type CollectOptions = {
  startLedger: number;
  contractIds: readonly string[];
  pageSize?: number;
  /** Upper bound on RPC round trips per call, so one tick stays bounded. */
  maxPages?: number;
};

/**
 * Collects every contract event from `startLedger` onwards, following the
 * RPC cursor across pages.
 *
 * A single `getEvents` call returns at most `pageSize` events. Advancing
 * the indexer to `latestLedger` after only the first page would silently
 * drop everything past it, so this keeps paging until a short page says
 * the range is drained.
 *
 * If `maxPages` is reached first, the range is not drained. Events in the
 * last ledger seen may be split across the page boundary, so that ledger
 * is dropped from the result and `throughLedger` stops just before it; the
 * next call starts there and picks up the whole ledger again.
 */
export async function collectEvents(
  source: EventSource,
  { startLedger, contractIds, pageSize = 200, maxPages = 50 }: CollectOptions,
): Promise<CollectedEvents> {
  const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [...contractIds] }];

  let res = await source.getEvents({ startLedger, filters, limit: pageSize });
  const events = [...res.events];
  let pages = 1;

  while (res.events.length >= pageSize) {
    if (pages >= maxPages) {
      // A full page is never empty, so the last event always exists.
      const lastLedger = events[events.length - 1]!.ledger;
      if (lastLedger <= startLedger) {
        // Every event so far is in one ledger and it still did not fit.
        // Dropping it would loop forever, so fail loudly instead.
        throw new Error(
          `ledger ${lastLedger} holds more than ${pageSize * maxPages} indexed events; ` +
            'raise maxPages',
        );
      }
      return {
        events: events.filter((e) => e.ledger < lastLedger),
        throughLedger: lastLedger - 1,
        hasMore: true,
      };
    }
    res = await source.getEvents({ cursor: res.cursor, filters, limit: pageSize });
    events.push(...res.events);
    pages += 1;
  }

  // The loop only exits on a short page, so the range is drained.
  return { events, throughLedger: res.latestLedger, hasMore: false };
}
