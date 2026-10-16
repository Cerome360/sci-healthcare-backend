# Changelog

## Unreleased

### Added
- **GET /receipts?provider=**: List receipts by clinic/provider. Beneficiary references omitted in this view.
- **GET /receipts/:voucherId**: Fetch a single receipt by voucher ID for shareable receipt pages and verification. No beneficiary reference in response.
- **GET /vouchers/due?within=72h**: Vouchers needing action soon (expiring, becoming refundable, or settleable) with funder or provider filter. Uses lifecycle logic from `src/lib/lifecycle.ts` so API and contracts agree.
- **Multi-status filter for vouchers**: `?status=Claimed,Attested` accepts comma-separated list validated against the status enum; invalid values rejected.
- **api:** `createdFrom`, `createdTo`, `minAmount` and `maxAmount` filters on `GET /vouchers`, for period and value-band reporting. Dates are ISO 8601 strings; amounts are base-unit strings compared numerically with `BigInt`.
- **api:** gzip compression (`@fastify/compress`) for responses above 1 KB, so payloads are smaller on slow clinic connections.
- **api:** standard security headers via `@fastify/helmet`; CSP is disabled because the API serves JSON only.
- **api:** tighter per-route rate limits for list routes (`GET /vouchers`, `/vouchers/due`, `/providers`, `/receipts`: 30 requests/minute), with `/health` and `/ready` exempt. The global default remains 120 requests/minute.

### Changed
- **GET /receipts**: Now requires exactly one of `beneficiaryRef` or `provider` query parameters.
- **GET /vouchers**: Status filter now accepts comma-separated values (e.g., `Claimed,Attested`) instead of a single value.

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
