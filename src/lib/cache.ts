import { createHash } from 'node:crypto';

import { prisma } from '../db.js';

/**
 * Short-lived HTTP caching for the read API.
 *
 * The read model only changes when the indexer commits a new ledger, which
 * happens at most about once every five seconds. A page reloaded in between
 * is guaranteed to be identical, so browsers and CDNs can reuse it instead
 * of making the API recompute it on a free-tier instance.
 *
 * The ETag is derived from the cursor (`IndexerState.lastLedger`) plus the
 * exact request URL, so changing any filter or path yields a different tag
 * and a different tag after a new ledger is indexed. Nothing is cached
 * server-side and no state is shared between instances: two API replicas
 * that have read the same cursor produce the same ETag.
 */

/** Reusable for five seconds, with a grace window while a revalidation runs. */
export const CACHE_CONTROL = 'public, max-age=5, stale-while-revalidate=30';

/** Used for health, operational endpoints and any error response. */
export const NO_STORE = 'no-store';

/**
 * Route patterns (without the `/v1` prefix) whose 200 responses may be
 * cached. Everything else — health, metrics, the OpenAPI document, the CSV
 * export and unknown routes — leaves caching headers to its own handler or
 * sends none, so this hook cannot accidentally make a dynamic response
 * reusable.
 */
const CACHEABLE_ROUTES = new Set([
  '/providers',
  '/providers/:address',
  '/providers/:address/history',
  '/providers/:address/services/:code/history',
  '/services',
  '/services/:code',
  '/countries',
  '/vouchers',
  '/vouchers/due',
  '/vouchers/:id',
  '/receipts',
  '/receipts/summary',
  '/receipts/:voucherId',
  '/governance',
  '/stats',
  '/version',
]);

/**
 * Operational endpoints that must never be cached.
 *
 * `/health` and `/ready` are probed by load balancers and monitoring, which
 * have to see the current state; an intermediary replaying a cached "ok"
 * would keep a broken instance in rotation. `/stream` is listed too: the 200
 * response hijacks the socket and never reaches this hook, but its rejections
 * (a bad filter, an instance at its connection cap) are ordinary JSON errors
 * that must not be reused by a cache either.
 */
const NO_STORE_ROUTES = new Set([
  '/health',
  '/ready',
  '/metrics',
  '/openapi.json',
  '/stream',
  '/docs',
  '/docs/',
  '/docs/json',
  '/docs/yaml',
]);

/** Strips the canonical `/v1` prefix so both aliases share one policy. */
function normalizeRoute(routeUrl: string): string {
  return routeUrl.startsWith('/v1/') ? routeUrl.slice(3) : routeUrl;
}

/**
 * The Cache-Control value for a matched route, or null when this hook has
 * no opinion about it.
 */
export function cachePolicy(routeUrl: string | undefined): string | null {
  if (!routeUrl) return null;
  const route = normalizeRoute(routeUrl);
  if (NO_STORE_ROUTES.has(route)) return NO_STORE;
  return CACHEABLE_ROUTES.has(route) ? CACHE_CONTROL : null;
}

/**
 * A weak validator tied to the cursor and the exact request URL.
 *
 * Weak (`W/`) because the representation is JSON whose bytes are not
 * guaranteed stable (key order, compression), but whose meaning is: the
 * same cursor and URL describe the same data. The hash keeps the header
 * short and keeps query strings with many filters out of it.
 */
export function cacheEtag(lastLedger: number, url: string): string {
  const digest = createHash('sha256').update(url).digest('base64url').slice(0, 16);
  return `W/"${lastLedger}-${digest}"`;
}

function weakTagValue(tag: string): string {
  return tag.trim().replace(/^W\//, '');
}

/**
 * Whether an `If-None-Match` header names our tag.
 *
 * Handles the comma-separated list and `*` forms, and compares weakly (per
 * RFC 9110) so a client that drops or adds `W/` still revalidates.
 */
export function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const ours = weakTagValue(etag);
  return raw.split(',').some((candidate) => {
    const value = candidate.trim();
    if (value === '*' && ours.length > 0) return true;
    return weakTagValue(value) === ours;
  });
}

/**
 * The cursor the read model is current to.
 *
 * Read once per cacheable request rather than cached in memory: a stale
 * value would hand out a 304 for data that has since changed, and this is a
 * single primary-key lookup. Null means the state row could not be read, in
 * which case the response is still served but without a validator.
 */
export async function lastIndexedLedger(): Promise<number | null> {
  try {
    const state = await prisma.indexerState.findUnique({
      where: { id: 1 },
      select: { lastLedger: true },
    });
    return state?.lastLedger ?? 0;
  } catch {
    return null;
  }
}
