# Load test: read API

How the read API behaves under concurrent load, with the harness committed so
the numbers can be reproduced and compared run to run. The harness is
[`scripts/loadtest.mjs`](../scripts/loadtest.mjs), driven by `npm run loadtest`.

It is a local, on-demand tool — not part of CI. It seeds a throwaway SQLite
database (`prisma/loadtest.db`), starts `src/api.ts` against it, and drives
three scenarios with [autocannon](https://github.com/mcollina/autocannon).

```sh
npm ci
npm run loadtest                      # seed + serve + all three scenarios (~50 s)
npm run loadtest -- --duration 30     # longer mixed scenario
npm run loadtest -- --clients 800     # more simulated clients in the mix
npm run loadtest -- --url http://127.0.0.1:8080   # target an existing instance
npm run loadtest -- --out /tmp/loadtest.json      # raw autocannon results
```

With `--url` nothing is seeded and no server is started: the target must
already carry data, or the numbers are meaningless.

## What gets seeded

2,500 vouchers, 500 receipts, 25 providers (a few suspended), 50 services.
Statuses follow a 100-slot cycle roughly matching a live system (30 Funded,
20 Claimed, 15 Attested, 20 Settled, 8 Disputed, 7 Refunded). All addresses
are deterministic, synthetic, and derived by sha256 — nothing real.

## Method notes

- **Clients are simulated with distinct source addresses.** Each request
  entry in the mixed scenario carries its own `X-Forwarded-For` from the
  documentation range (198.51.0.0/16). That models an announcement — many
  clients, each with its own bucket in the per-address rate limiter — rather
  than one host hammering the API. The API sets `trustProxy: true`, so
  `req.ip` (and therefore the limiter bucket) follows `X-Forwarded-For`;
  deployments reachable from the open internet should make sure their proxy
  is configured accordingly.
- **Percentiles**: autocannon does not emit p95; the table quotes p97.5 (its
  nearest) alongside p50 and p99.
- **Comparing within, not across, scenarios.** Scenario 1 saturates the
  server with 50 connections, so its p50 includes queueing time; scenario 3
  uses 10 connections. Latencies are comparable between the two arms of
  scenario 3 (identical offered load, back to back), not across scenarios.
- **The rate limiter is part of the system under test.** Scenario 2
  deliberately stays on one source address to show the limiter working as
  designed: 120 requests in the window, then 429s. The other scenarios draw
  from enough distinct addresses that the limiter does not interfere with
  the throughput measurement.

## Reference run

Local run, 2026-10-16. Hardware: **Apple M1 Pro (8 cores), 16 GiB RAM,
macOS 27 (darwin 27.0.0), Node v22.23.3**, SQLite (throwaway local file).
The script prints the same host line at the end of every run.

### Scenario 1 — mixed list/detail (400 clients, 50 connections, 15 s)

80% list requests (`status`/`funder`/`provider` filters, limits 20–50), 20%
voucher detail, one distinct source address per entry.

| throughput | total | p50 | p97.5 | p99 | max | errors | non-2xx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2,615 req/s | 39,210 | 18 ms | 31 ms | 35 ms | 182 ms | 0 | 0 |

### Scenario 2 — single client (1 connection, 10 s) — rate limiter behaviour

| throughput | total | 2xx | 429 | p50 | max |
| --- | --- | --- | --- | --- | --- |
| 14,077 req/s | 154,838 | 119 | 154,719 | 0 ms | 6 ms |

The 119 answered requests are the per-address allowance; everything after
that is a fast 429. The limiter itself adds no measurable latency.

### Scenario 3 — `sort=amount` probe (10 connections, 5 s per arm, 600 addresses)

Same filter (`status=Settled`, 500 matching rows), differing only in `sort`:

| request | throughput | total | p50 | p97.5 | p99 | max | non-2xx |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `?status=Settled&limit=20` (index order) | 2,151 req/s | 10,755 | 4 ms | 6 ms | 7 ms | 41 ms | 0 |
| `?status=Settled&sort=amount&limit=20` | 216 req/s | 1,080 | 45 ms | 54 ms | 72 ms | 86 ms | 0 |

## Findings

- **`sort=amount` is ~10× slower than its index-ordered twin** (216 vs
  2,151 req/s; p50 45 ms vs 4 ms) at only 500 matching rows, because the
  route loads every matching voucher and sorts in memory on each request
  (`src/routes/vouchers.ts`). The gap grows with match-set size — filed as
  [#96](https://github.com/Godgift-care/sci-healthcare-backend/issues/96).
- No connection errors, timeouts, 5xx, or 3xx anywhere in any scenario. The
  read paths themselves are stable under saturation; the mixed scenario
  sustained 2.6k req/s with all 2xx.

## Caveats

- Localhost SQLite on an idle laptop is a **comparative benchmark**, not an
  SLA: production runs Postgres behind a proxy, over a network. Use these
  numbers to catch regressions between code changes, not to promise
  production latency.
- The seed is synthetic. Filter selectivities differ from production;
  `funder` and `provider` filters in the mix are spread across 40/25 values,
  which is deliberately not adversarial.
