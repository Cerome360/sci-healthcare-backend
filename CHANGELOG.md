# Changelog

## Unreleased

### Changed
- **Versioned migrations**: production now applies reviewed migrations from `prisma/migrations/` with `prisma migrate deploy` instead of `db push --accept-data-loss`. `20260101000000_init` is the Postgres baseline of the previous schema and `20260102000000_failed_events` adds `FailedEvent`. A CI `migrations` job applies them to a fresh Postgres and fails if the schema and migrations drift. **Existing production databases must run `npx prisma migrate resolve --applied 20260101000000_init` once** (see README "Deploying").
- **Batched indexer writes**: all events from one poll cycle are applied in a single transaction together with the cursor update, with a savepoint per event so a failing event rolls back only itself. A crash mid-cycle leaves the cursor unchanged.

### Added
- **Indexer backoff on RPC errors**: a failed cycle now doubles the wait before the next one (`nextDelay`, exponential from `INDEXER_POLL_MS` with 25% jitter, capped by the new `INDEXER_BACKOFF_MAX_MS`, default 60s) and resets on the first cycle that works. The failure is logged once per streak instead of once per attempt, with a matching `indexer recovered` line carrying the attempt count.
- **RPC failover**: `SOROBAN_RPC_URLS` takes a comma-separated list of endpoints; `SOROBAN_RPC_URL` still works and is used when the list is unset. After `SOROBAN_RPC_MAX_FAILURES` consecutive failures (default 3) reads move to the next endpoint and the switch is logged. `/version` reports every configured endpoint and `/ready` reports the active one as `checks.rpcUrl`, both redacted.
- **Reconciliation against the chain**: `npm run indexer:reconcile [-- --fix] [-- --sample <n>]` compares every non-terminal voucher (plus a rolling sample of terminal ones, default 25) with `get_voucher` through simulation. Differences are recorded in the new `ReconcileMismatch` table and exposed on `/ready` as `checks.reconcileMismatches` and `checks.reconcile`. Drift is reported but does not make `/ready` 503: unlike a failed event it says nothing about whether the instance can serve traffic. `--fix` rewrites the differing rows from chain state; the command exits non-zero while any mismatch is open. See `docs/RUNBOOK.md`.
- **Faucet drip counts**: with the optional `FAUCET_CONTRACT_ID` set, the indexer subscribes to the testnet faucet and projects its `dripped` events into the new `FaucetDrip` table (keyed by on-chain event id, so replay cannot inflate the count). `/stats` gains `faucetDrips` and `faucetWallets` (distinct wallets), both `0` when no faucet is configured.
- **Prometheus metrics**: `/metrics` serves Prometheus text with default process metrics, `indexer_lag_ledgers`, `indexer_seconds_since_success`, `events_applied_total{name}`, `events_skipped_total{name}`, and `http_requests_total` / `http_request_duration_seconds` labelled by route pattern. It is exempt from the public rate limit. Indexer series are populated in the process that runs the indexer (combined mode or the worker).
- **Dead-lettered events**: an event that fails to project is stored in the new `FailedEvent` table (id, name, ledger, raw XDR, error, attempts, first/last seen) instead of only being logged. `/ready` reports degraded while any exist (`checks.failedEvents`). `npm run indexer:retry-failed` re-decodes and re-applies them, deleting rows that succeed. The table is created by the `20260102000000_failed_events` migration.
- **OpenAPI spec and Swagger UI**: `@fastify/swagger` generates the spec from Zod schemas. Served at `/docs` (Swagger UI) and `/openapi.json` (raw spec). Amount fields documented as decimal strings.
- **Cursor pagination**: All list endpoints accept `cursor` and `limit`. Responses carry `nextCursor` (null when exhausted). Cursors encode `(createdAt, id)` as base64url. Offset pagination kept with a `Deprecation` header for one release.
- **RPC retention gap detection**: The indexer detects when its cursor falls outside the RPC retention window, marks itself degraded (`gap` flag in `IndexerState`), and `/ready` returns 503 with gap details and a pointer to `docs/RUNBOOK.md`.
- **Backfill command**: `npm run indexer:backfill -- --from <ledger> [--to <ledger>]` replays events without touching the cursor. Idempotent; refuses to start before the RPC retention window.
- **`docs/RUNBOOK.md`**: Recovery procedures for the retention gap.
- **`/v1` API versioning**: every route is also served under `/v1`. The unversioned paths remain as aliases and carry `Deprecation: true` plus a `Link` header naming the `/v1` successor.
- **`X-Request-Id`**: accepted (validated, log-safe) or generated, echoed on every response and present as `reqId` in the matching log line.
- **GET /vouchers.csv**: streamed RFC 4180 CSV export with the same filters as `GET /vouchers`. At least one filter is required and there is no beneficiary reference column.
- **GET /services**: Service catalogue across active clinics, grouped by code, with unique labels, clinic count and min/max/median price. Aggregates are computed with `BigInt`; the median of an even number of prices is the floor of the mean of the two middle values.
- **GET /services/:code**: Active clinics offering one service code, cheapest first, each with `price` and `priceDisplay`.
- **GET /countries**: Countries with at least one active clinic and their clinic counts, for building filters without paging every provider.
- **GET /providers?q=**: Case-insensitive clinic name search, length-capped at 64 characters. Uses `mode: 'insensitive'` on Postgres; SQLite's `LIKE` is case-insensitive for ASCII.
- **GET /vouchers sort options**: `?sort=createdAt|expiresAt|amount` and `?order=asc|desc` (defaults `createdAt`/`desc`, matching previous behaviour). `amount` is sorted numerically with `BigInt`, not lexicographically; ties fall back to the voucher id in the same direction.
- **GET /receipts?provider=**: List receipts by clinic/provider. Beneficiary references omitted in this view.
- **GET /receipts/:voucherId**: Fetch a single receipt by voucher ID for shareable receipt pages and verification. No beneficiary reference in response.
- **GET /vouchers/due?within=72h**: Vouchers needing action soon (expiring, becoming refundable, or settleable) with funder or provider filter. Uses lifecycle logic from `src/lib/lifecycle.ts` so API and contracts agree.
- **Multi-status filter for vouchers**: `?status=Claimed,Attested` accepts comma-separated list validated against the status enum; invalid values rejected.
- **`READY_MAX_LAG_LEDGERS`** (default `120`): lag in ledgers at which `/ready` reports degraded. The response echoes it as `checks.maxLagLedgers`.
- **Split API and indexer entry points**: `npm run start:api` and `npm run start:indexer`; combined `npm start` stays the default. Commented two-service example in `render.yaml`.
- **Indexer lease**: `IndexerState.leaseOwner` / `leaseExpiresAt` make the cursor single-writer. Standby instances log and retry instead of racing the cursor.
- **Automated dependency updates**: `.github/dependabot.yml` opens one grouped npm PR a week (minor and patch) and one for GitHub Actions. Prisma updates arrive as their own PR labelled `do-not-merge`, so the auto-merge bot holds them until a maintainer has looked.

### Changed
- **`/stats` response**: two new fields, `faucetDrips` and `faucetWallets`. Existing fields are unchanged.
- **`/version` response**: `rpcUrl` is now the endpoint currently in use rather than the configured one (they differ only after a failover), plus a new `rpcUrls` array and `contracts.faucet`.
- **Schema**: two new tables, `FaucetDrip` and `ReconcileMismatch`, added by the `20260103000000_faucet_drips_and_reconcile` migration. Nothing existing is touched and no backfill is needed.
- **List endpoints**: Prefer `cursor`/`limit` over `offset`/`limit`. Offset pagination still works but returns a `Deprecation` header.
- **`IndexerState` schema**: three nullable columns added (`gap`, `gapOldestLedger`, `gapCursorLedger`); `prisma db push` adds them in place.
- **Error responses**: every route now returns the one `{ error, message, details? }` envelope via the app-level error and not-found handlers. Unhandled failures are `internal_error`, with the cause left in the log rather than the response.
- **GET /receipts**: Now requires exactly one of `beneficiaryRef` or `provider` query parameters.
- **GET /vouchers**: Status filter now accepts comma-separated values (e.g., `Claimed,Attested`) instead of a single value.
- **Indexer logs**: skipped events now include the transaction hash and ledger; an unknown event name is warned once per process instead of silently ignored.
- **`IndexerState` schema**: two nullable columns added; `prisma db push` adds them in place (no backfill needed).

### Fixed
- **tests:** vitest now collects only `src/**/*.test.ts`. The `node:test` suite at `.github/scripts/automerge.test.cjs` has its own CI job, but was also being collected by vitest and failed `npm test` as "no test suite found".

## 0.2.0 — 2026-10-09

### Fixed
- **indexer:** follows the RPC cursor across pages. Previously any backlog over 200 events lost everything after the first page, because the cursor jumped to the RPC tip.

### Added
- Route tests for every endpoint against a throwaway SQLite database, through a new `buildApp()` that builds the API without starting the indexer. Tests: 57 (was 19).
- Issue forms (bug, feature) and a pull request template; blank issues off, security reports routed to SECURITY.md.
- `serviceLabel` on vouchers and receipts; `refundableAt` and `disputeReason` on vouchers. `isRefundable` follows the contract's claim-grace rule.
- `Voucher.disputeReason` column (nullable; `prisma db push` adds it in place).
- `npm run lint` (ESLint 9 + typescript-eslint) and a lint job in CI.

### Changed
- Points at the 2026-10-07 testnet deployment; `INDEXER_START_LEDGER` updated.

## 0.1.0 — 2026-09-02

Initial indexer and read API.
