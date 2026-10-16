/**
 * Rate limits by route cost, shared between the global registration in
 * `app.ts` and the per-route overrides in each route module.
 */

/** Default budget for cheap routes: point lookups and counters. */
export const DEFAULT_RATE_LIMIT = { max: 120, timeWindow: '1 minute' };

/**
 * List routes scan the read model and cost far more than a point lookup,
 * so they get a tighter budget. Protects the free-tier database from
 * scraping while leaving `/health` and `/ready` free to probe.
 */
export const LIST_ROUTE_RATE_LIMIT = { max: 30, timeWindow: '1 minute' };
