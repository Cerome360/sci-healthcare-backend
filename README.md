<p align="center">
  <img src="docs/banner.png" alt="SCI Healthcare" width="640" />
</p>

<p align="center">
  <a href="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/ci.yml">
    <img src="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/monitor.yml">
    <img src="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/monitor.yml/badge.svg" alt="Uptime monitor" />
  </a>
  <img src="https://img.shields.io/badge/node-22-green" alt="node 22" />
  <img src="https://img.shields.io/badge/fastify-5.12-black" alt="fastify" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="Apache 2.0" />
</p>

# SCI Healthcare — Indexer &amp; API | [Documentation](https://godgift-care.github.io/sci-healthcare-contracts/) | [Privacy Policy](docs/privacy.md)

> **Live:** [App](https://sci-healthcare.vercel.app) · [API](https://sci-healthcare-api.onrender.com/stats) · [Docs](https://godgift-care.github.io/sci-healthcare-contracts/) · [Privacy](docs/privacy.md) · [Contracts on testnet](https://stellar.expert/explorer/testnet/contract/CBPUQN6CNJCNGPKNEXB7UM4T7RINKQB7HQI5CXEOSQ5EFRHE4G4VKPSQ)
>
> The API runs on Render's free tier and sleeps after ~15 minutes idle; the first
> request may take 30–60 seconds to wake it.

Indexes Soroban contract events from the [SCI Healthcare care-voucher protocol](https://github.com/Godgift-care/sci-healthcare-contracts) into a queryable read model, and serves it over a read-only HTTP API.

The ledger is the source of truth. This service exists because a ledger cannot answer "show me every voucher this clinic is waiting on" without scanning it. Everything here is a projection: delete the database, replay from the deploy ledger, and you get the same rows back.

<p align="center">
  <a href="https://render.com/deploy?repo=https://github.com/Godgift-care/sci-healthcare-backend">
    <img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" />
  </a>
</p>

One click provisions the web service and its Postgres instance in the same
region, with every contract id already set. The only value you add by hand is
`CORS_ORIGIN`, once the frontend URL exists.

## Maintainers

<table align="center">
  <tr>
    <td align="center">
      <img src="https://github.com/adelekevat.png" width="140" alt="Maintainer" />
      <br /><br />
      <strong>Adeleke | Backend &amp; Indexer</strong>
      <br /><br />
      <a href="https://github.com/adelekevat">adelekevat</a>
    </td>
  </tr>
</table>

## Two properties worth stating up front

**It holds no keys and signs nothing.** Every state change in this protocol is a transaction signed in the user's wallet and submitted straight to Soroban RPC by the browser. This service is not in the write path. There is no custody here to steal.

**It stores no patient data.** The only patient-linked value is `beneficiaryRef`, an opaque 32-byte HMAC computed in the user's browser under a key that never leaves it. Nothing is written here that is not already public on chain, so a database breach is not a health-data breach.

## Architecture

```
  Soroban RPC ──getEvents──> Indexer ──> SQLite / Postgres ──> Fastify (read-only)
                             (cursor,                                   │
                              idempotent                                ▼
                              upserts)                              Frontend
```

The indexer polls on an interval, applies each event to the read model, and only then advances its cursor — so a crash mid-batch replays rather than skips. Handlers are idempotent upserts keyed by on-chain id, which makes replay safe.

The cursor is guarded by a lease (stored on `IndexerState`). However many indexer processes are running, exactly one holds the lease and advances the cursor; the others log that they are standing by and retry. Events are idempotent, but the cursor is not — two writers can skip events by advancing it from a stale read — which is the race the lease exists to prevent.

When the RPC fails, the indexer backs off exponentially (with jitter, up to `INDEXER_BACKOFF_MAX_MS`) instead of retrying every poll interval, and reports the failure once per streak rather than once per attempt — retrying at full speed adds load exactly where it hurts and buries every other log line. Configure more than one endpoint in `SOROBAN_RPC_URLS` and repeated failures move reads to the next one; the active endpoint is logged on each switch and reported as `checks.rpcUrl` on `/ready`.

On `SIGTERM` (every Render deploy) or `SIGINT`, the indexer stops scheduling new cycles, waits for the cycle in flight to commit its transaction and save the cursor (bounded by `SHUTDOWN_TIMEOUT_MS`), then releases the lease so the replacement instance can take over immediately. The process then closes the HTTP server and the database connection, with a hard exit as a backstop. If the cycle overruns the timeout the lease is deliberately left to expire rather than freed, so a peer cannot race a cycle that may still be committing.

See [docs/architecture.md](docs/architecture.md) for the full walkthrough: the paging and decode stages, the cursor and lease model, idempotency rules, and each failure mode with what to do about it.

## API

Every route is served under the canonical `/v1` prefix. The unversioned paths
(`/vouchers`, `/providers`, …) remain as aliases for clients already deployed
against them: each response on those paths carries `Deprecation: true` and a
`Link: </v1/...>; rel="successor-version"` header. New integrations should
target `/v1`.

Every response carries an `X-Request-Id`. Send one and it is echoed (after
validation); otherwise the server generates a UUID. The same value appears as
`reqId` in the log line for the request, so an id from a user is enough to find
the matching log entry.

Errors all use one envelope, whatever layer rejected the request:

```json
{ "error": "invalid_query", "message": "Invalid query parameters", "details": [] }
```

`details` is present only when there is something structured to add (for
example the Zod issues for a bad query). Error codes: `invalid_query`,
`filter_required`, `invalid_code`, `provider_not_found`, `service_not_found`,
`voucher_not_found`, `receipt_not_found`, `route_not_found`, `rate_limited`,
`stream_full`, `bad_request`, `internal_error`. A 5xx is always `internal_error`; the cause
stays in the log, never in the response.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness |
| `GET /ready` | Readiness; 503 once the indexer trails by more than `READY_MAX_LAG_LEDGERS` |
| `GET /version` | Build version and commit, network, RPC endpoints, contract ids, indexer start ledger and process start time |
| `GET /stats` | Protocol counters for the dashboard |
| `GET /providers` | Verified clinics, filterable by `status`, `country`, `q` (case-insensitive name search) |
| `GET /providers/:address` | One clinic and its service catalogue |
| `GET /providers/:address/history` | Every status transition for a clinic, oldest first |
| `GET /providers/:address/services/:code/history` | Every observed price for a service, oldest first |
| `GET /countries` | Countries with at least one active clinic and their clinic counts |
| `GET /services` | Active services grouped by code: labels, clinic count, min/max/median price |
| `GET /services/:code` | Active clinics offering a service code with their prices, cheapest first |
| `GET /vouchers` | Vouchers by `funder`, `provider`, `beneficiaryRef` or `status`, sorted by `sort`/`order` |
| `GET /vouchers/due` | Vouchers needing action soon (expiring, refundable or settleable) within `within`, e.g. `72h` |
| `GET /vouchers.csv` | Streamed CSV export matching the same filters as `GET /vouchers` |
| `GET /vouchers/:id` | One voucher, with its care receipt if settled |
| `GET /receipts?beneficiaryRef=` / `?provider=` | A patient's settled care history, or a clinic's receipts |
| `GET /receipts/:voucherId` | One receipt, for a shareable receipt page |
| `GET /governance` | Current and pending admin per contract, plus the handover history |
| `GET /stream` | Live voucher state transitions as the indexer commits them (server-sent events) |

`GET /vouchers` **requires at least one filter**. An unfiltered dump of every voucher is not a useful endpoint and invites scraping. It accepts `sort=createdAt|expiresAt|amount` and `order=asc|desc` (defaults: `createdAt`, `desc`). Amounts are compared with `BigInt`, so `amount` sorting is numeric rather than lexicographic.

`GET /vouchers.csv` takes the same `funder`, `provider`, `beneficiaryRef` and
`status` filters (and also requires at least one). Rows are read in batches
with a cursor and streamed as an RFC 4180 download, so the export never has to
fit in memory however many vouchers match. It deliberately has **no beneficiary
reference column**.

`/receipts` requires an exact `beneficiaryRef`. Because that value is an HMAC under a key held by the patient, the endpoint cannot be walked to enumerate people.

Every receipt — the patient view, the clinic view and `GET /receipts/:voucherId`
— carries the clinic that issued it in a `provider` object (`address`, `name`,
`country`), the same shape `GET /vouchers` uses, so a receipt page no longer has
to resolve the address separately. A receipt whose clinic is not in the registry
reports `name: null` and `country: null` instead of being dropped from its own
history: the settled care still happened. Clinic names and countries are public
on-chain registry data; no receipt response gains a beneficiary reference.

`GET /stream?voucher=<id>` or `GET /stream?provider=<address>` holds the
connection open and forwards each voucher transition as the indexer commits it:
one `data:` frame per event, containing `type`, `voucherId`,
`providerAddress`, `status`, `ledger`, `txHash` and `at`. Exactly one filter is
required — an unfiltered feed of care-state transitions would be a way to watch
a clinic's patient volume in real time — and a frame never carries a beneficiary
reference, only what the JSON routes already expose for the same transition.
Nothing is read from the database to serve the stream, so it cannot become a
second way to walk the read model: it only reports what just happened.

Operationally: a frame is written only after the transaction that produced it
commits, so the stream cannot announce a state the API cannot yet serve; a
client that cannot drain what it is given is disconnected rather than allowed to
pin a write buffer in this process; idle streams emit a `: heartbeat` comment
every `SSE_HEARTBEAT_MS`; and one instance holds at most
`SSE_MAX_CONNECTIONS` streams, answering `503 stream_full` past that. Shutting
the server down ends the open streams instead of waiting on them. Because the
indexer and the streams have to share a process, the feed is live in combined
mode; in a split deployment an API-only process has nothing to subscribe to and
its streams only beat (see "Running the indexer and the API separately").

### Response behaviour

List routes (`/vouchers`, `/vouchers/due`, `/providers`, `/receipts`) are limited to 30 requests
per minute per client; other routes default to 120, while `/health` and `/ready`
are exempt so a struggling service can always be probed. JSON above 1 KB is
gzip-compressed when the client accepts it, and every response carries the
standard `@fastify/helmet` security headers (no CSP — this API serves JSON, not
HTML).

List and detail routes are cacheable for a short window. They send
`Cache-Control: public, max-age=5, stale-while-revalidate=30` and a weak `ETag`
derived from the indexer's last ledger and the exact request URL, so a reload
with a matching `If-None-Match` gets `304 Not Modified` without the API touching
the read model. A newly indexed ledger changes every tag, and a different filter
is a different tag. `/health`, `/ready`, `/metrics` and `/openapi.json` are
`Cache-Control: no-store`, as is every error response. Nothing is cached
server-side, so any instance can validate a tag produced by another.

### Examples

- **Telegram Bot for Clinics**: [`examples/telegram-bot/`](examples/telegram-bot/README.md) demonstrates how clinic microservices verify `X-SCI-Signature` HMAC-SHA256 signatures on webhook notifications and post real-time voucher alerts without exposing patient/beneficiary data.

### Endpoints and Examples

#### 1. Operations & System
- **`GET /health`**: Quick liveness probe.
  ```bash
  curl http://localhost:8080/health
  ```
  ```json
  { "status": "ok", "time": "2026-09-02T12:00:00.000Z" }
  ```
- **`GET /ready`**: Readiness probe checking database connectivity and indexer sync lag.
  ```bash
  curl http://localhost:8080/ready
  ```
  ```json
  { "status": "ok", "indexer": { "latestLedger": 4465530, "targetLedger": 4465530, "lag": 0 } }
  ```
- **`GET /version`**: Application version and git commit metadata.
  ```bash
  curl http://localhost:8080/version
  ```
  ```json
  { "version": "0.2.0", "commit": "44b3de9" }
  ```
- **`GET /metrics`**: Prometheus metrics for HTTP traffic, latency, and indexer state.
  ```bash
  curl http://localhost:8080/metrics
  ```
  ```text
  # HELP http_requests_total Total number of HTTP requests
  # TYPE http_requests_total counter
  http_requests_total{method="GET",route="/health",status="200"} 42
  ```

#### 2. Healthcare Providers
- **`GET /v1/providers`**: List registered clinics with active services, filtered by status, country, or name search.
  ```bash
  curl "http://localhost:8080/v1/providers?status=Active&country=NG&limit=10"
  ```
  ```json
  {
    "total": 1,
    "providers": [
      {
        "address": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "name": "Ikeja General Clinic",
        "country": "NG",
        "status": "Active",
        "registeredAt": "2026-09-01T08:00:00.000Z",
        "services": [
          { "code": 101, "label": "Outpatient consult", "price": "30000000", "priceDisplay": "3.0000000" }
        ]
      }
    ]
  }
  ```
- **`GET /v1/providers/:address`**: Fetch details of a single provider by Stellar address.
  ```bash
  curl http://localhost:8080/v1/providers/GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK
  ```
  ```json
  {
    "address": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
    "name": "Ikeja General Clinic",
    "country": "NG",
    "status": "Active",
    "services": [
      { "code": 101, "label": "Outpatient consult", "price": "30000000", "priceDisplay": "3.0000000" }
    ]
  }
  ```

#### 3. Medical Services Catalog
- **`GET /v1/services`**: List all medical services offered across active providers.
  ```bash
  curl "http://localhost:8080/v1/services?provider=GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK"
  ```
  ```json
  {
    "services": [
      {
        "code": 101,
        "label": "Outpatient consult",
        "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "price": "30000000",
        "priceDisplay": "3.0000000",
        "active": true
      }
    ]
  }
  ```
- **`GET /v1/services/:code`**: Look up active offerings for a standard service code.
  ```bash
  curl http://localhost:8080/v1/services/101
  ```
  ```json
  {
    "code": 101,
    "providers": [
      {
        "address": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "name": "Ikeja General Clinic",
        "price": "30000000",
        "priceDisplay": "3.0000000"
      }
    ]
  }
  ```

#### 4. Vouchers & Protocol Statistics
- **`GET /v1/vouchers`**: Filter vouchers by funder, provider, beneficiary reference, or status.
  ```bash
  curl "http://localhost:8080/v1/vouchers?status=Funded&limit=10"
  ```
  ```json
  {
    "total": 1,
    "vouchers": [
      {
        "id": "1",
        "funder": "GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45",
        "beneficiaryRef": "72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745",
        "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "serviceCode": 101,
        "amount": "30000000",
        "amountDisplay": "3.0000000",
        "status": "Funded",
        "createdAt": "2026-09-02T10:00:00.000Z",
        "expiresAt": "2026-09-09T10:00:00.000Z"
      }
    ]
  }
  ```
- **`GET /v1/vouchers/:id`**: Get full state and current lifecycle status of a voucher.
  ```bash
  curl http://localhost:8080/v1/vouchers/1
  ```
  ```json
  {
    "id": "1",
    "funder": "GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45",
    "beneficiaryRef": "72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745",
    "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
    "serviceCode": 101,
    "amount": "30000000",
    "amountDisplay": "3.0000000",
    "status": "Funded",
    "createdAt": "2026-09-02T10:00:00.000Z",
    "expiresAt": "2026-09-09T10:00:00.000Z"
  }
  ```
- **`GET /v1/vouchers/:id/events`**: Chronological event history for a voucher.
  ```bash
  curl http://localhost:8080/v1/vouchers/1/events
  ```
  ```json
  {
    "events": [
      {
        "type": "VoucherCreated",
        "ledger": 4465529,
        "timestamp": "2026-09-02T10:00:00.000Z",
        "txHash": "abc123def456"
      }
    ]
  }
  ```
- **`GET /v1/vouchers/due`**: Unredeemed vouchers nearing expiration.
  ```bash
  curl "http://localhost:8080/v1/vouchers/due?withinHours=24"
  ```
  ```json
  {
    "total": 1,
    "vouchers": [
      { "id": "1", "status": "Funded", "expiresAt": "2026-09-03T10:00:00.000Z" }
    ]
  }
  ```
- **`GET /v1/vouchers.csv`**: Export voucher records as standard CSV for donor reporting and accounting.
  ```bash
  curl -o vouchers.csv "http://localhost:8080/v1/vouchers.csv?funder=GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45"
  ```
- **`GET /v1/stats`**: High-level protocol metrics including total volume and voucher counters.
  ```bash
  curl http://localhost:8080/v1/stats
  ```
  ```json
  {
    "vouchers": { "funded": 100, "redeemed": 85, "cancelled": 5, "expired": 10 },
    "volumeTotal": "3000000000",
    "volumeDisplay": "300.0000000"
  }
  ```

#### 5. Care Receipts
- **`GET /v1/receipts`**: List anonymized care receipts minted on redemption.
  ```bash
  curl "http://localhost:8080/v1/receipts?provider=GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK&limit=10"
  ```
  ```json
  {
    "total": 1,
    "receipts": [
      {
        "id": "1",
        "voucherId": "1",
        "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "serviceCode": 101,
        "amount": "30000000",
        "mintedAt": "2026-09-02T14:30:00.000Z"
      }
    ]
  }
  ```
- **`GET /v1/receipts/:id`**: Get care receipt by id.
  ```bash
  curl http://localhost:8080/v1/receipts/1
  ```
  ```json
  {
    "id": "1",
    "voucherId": "1",
    "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
    "serviceCode": 101,
    "amount": "30000000",
    "mintedAt": "2026-09-02T14:30:00.000Z"
  }
  ```

#### 6. Governance & Protocol Administration
- **`GET /v1/governance/proposals`**: List DAO proposals and voting states.
  ```bash
  curl "http://localhost:8080/v1/governance/proposals?status=Active"
  ```
  ```json
  {
    "proposals": [
      {
        "id": 1,
        "title": "Add Nairobi Health Clinic",
        "status": "Active",
        "yesVotes": "50000000",
        "noVotes": "0"
      }
    ]
  }
  ```
- **`GET /v1/governance/proposals/:id`**: Detailed proposal votes and execution target.
  ```bash
  curl http://localhost:8080/v1/governance/proposals/1
  ```
  ```json
  {
    "id": 1,
    "title": "Add Nairobi Health Clinic",
    "status": "Active",
    "proposer": "GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45"
  }
  ```
- **`GET /v1/governance/history`**: Admin actions and parameter updates log.
  ```bash
  curl http://localhost:8080/v1/governance/history
  ```
  ```json
  {
    "history": [
      { "action": "ProviderApproved", "target": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK", "ledger": 4465520 }
    ]
  }
  ```

#### 7. Real-Time Server-Sent Events (SSE)
- **`GET /v1/stream`**: Real-time event stream subscribing to voucher and protocol events.
  ```bash
  curl -N "http://localhost:8080/v1/stream?voucher=1"
  ```
  ```text
  event: voucher_update
  data: {"id":"1","status":"Redeemed","updatedAt":"2026-09-02T14:30:00.000Z"}
  ```

Amounts are `i128` on chain and are returned as **decimal strings**. Parsing one into a JavaScript number loses precision above 2^53 — use `BigInt`.

## Quick start

```bash
git clone https://github.com/Godgift-care/sci-healthcare-backend
cd sci-healthcare-backend
npm install
cp .env.example .env          # fill in the contract ids below
npx prisma generate
npx prisma db push
npm run dev
```

## Environment

Every variable the service reads, in one table. The Zod schema in
`src/env.ts` is the source of truth and the process refuses to start when a
required variable is missing; `src/__tests__/env-docs.test.ts` fails when
this table and the schema drift apart.

| Variable | Required | Default | Example | What it does |
| --- | --- | --- | --- | --- |
| `PORT` | No | `8080` | `8080` | HTTP port the API listens on |
| `HOST` | No | `0.0.0.0` | `0.0.0.0` | Address the API binds to |
| `LOG_LEVEL` | No | `info` | `info` | pino log level: `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `CORS_ORIGIN` | No | `http://localhost:3000` | `https://sci-healthcare.vercel.app` | Comma-separated origins allowed to call the API |
| `READY_MAX_LAG_LEDGERS` | No | `120` | `120` | Indexer lag in ledgers at which `/ready` reports degraded (503) |
| `DATABASE_URL` | Yes | — | `file:./dev.db` | Database connection string. SQLite paths resolve **relative to `prisma/`**; production uses a Postgres URL |
| `STELLAR_NETWORK` | No | `testnet` | `testnet` | Stellar network: `testnet`, `public` or `futurenet` |
| `SOROBAN_RPC_URL` | No | — | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint (used when `SOROBAN_RPC_URLS` is unset) |
| `SOROBAN_RPC_URLS` | No | — | `https://rpc-a.example,https://rpc-b.example` | Comma-separated endpoints, tried in order on repeated failure |
| `SOROBAN_RPC_MAX_FAILURES` | No | `3` | `3` | Consecutive failures against one endpoint before switching |
| `NETWORK_PASSPHRASE` | Yes | — | `Test SDF Network ; September 2015` | Network passphrase used when building contract-read simulations |
| `REGISTRY_CONTRACT_ID` | Yes | — | `CAMU635NRFEHATJ6MTY5SI43IAZ43KHPFXAQDQAST2AHKCHLSGWHVE4V` | Clinic registry contract id; indexed for providers and admin history |
| `VOUCHER_CONTRACT_ID` | Yes | — | `CBPUQN6CNJCNGPKNEXB7UM4T7RINKQB7HQI5CXEOSQ5EFRHE4G4VKPSQ` | Voucher escrow contract id; indexed for vouchers |
| `RECEIPT_CONTRACT_ID` | Yes | — | `CBCJRI2BCZBMZNX77WWDC2NGSV4ZNAN5Q23XHYNBH6UTOQMPJHZGX5C7` | Care-receipt contract id; indexed for minted receipts |
| `USDC_CONTRACT_ID` | No | — | `CCRLJ7FEIKTR3GBT3VQQPSIJGRBO2WPNMVFKJDP6AYGJQWECOR4QVE5M` | Optional settlement-token (USDC) contract id, validated when set |
| `FAUCET_CONTRACT_ID` | No | — | `CCB25WG7DQ2CSNXPTOHZO2PDZ324FQPZLH3LSNCCLWYM3FEH52GEXC47` | Testnet demo faucet; optional, drips counted in `/stats` when set |
| `DEPLOYMENTS` | No | — | `[{"type":"registry","contractId":"C...","fromLedger":123}]` | Optional JSON array of previous contract deployments for redeployment support |
| `INDEXER_START_LEDGER` | No | `0` | `4465529` | Ledger to index from; `0` means start at the current tip and skip prior history |
| `INDEXER_POLL_MS` | No | `5000` | `5000` | Milliseconds between indexer polls once caught up |
| `INDEXER_BACKOFF_MAX_MS` | No | `60000` | `60000` | Ceiling for the backoff applied after RPC failures |
| `SHUTDOWN_TIMEOUT_MS` | No | `15000` | `15000` | How long SIGTERM/SIGINT waits for the indexer cycle in flight before the process hard-exits |
| `SSE_HEARTBEAT_MS` | No | `15000` | `15000` | Idle interval between `: heartbeat` comments on `GET /stream` |
| `SSE_MAX_CONNECTIONS` | No | `64` | `64` | Concurrent `GET /stream` connections one process will hold; past that the route answers `503 stream_full` |

Set `INDEXER_START_LEDGER` to the deployment ledger. Leaving it at `0` starts at the current tip and silently skips all prior history. Soroban RPC also only retains a rolling window of ledgers (about 7 days on testnet) — an indexer that falls further behind than the window cannot catch up, and `/ready` will say so rather than pretend otherwise.

`READY_MAX_LAG_LEDGERS` (default `120`, about ten minutes at five seconds a ledger) is where `/ready` flips from 200 to 503. A free-tier demo can tolerate a much larger window than production, so tune it per deployment. `GET /ready` echoes it as `checks.maxLagLedgers`.

`SOROBAN_RPC_URLS` is the failover list. Set it to two endpoints and an outage at the first one costs a few failed reads rather than an indexing stall; with one endpoint (or only `SOROBAN_RPC_URL` set) the behaviour is exactly as before. `GET /version` reports every configured endpoint and `GET /ready` reports the active one, both with any credentials redacted.

`SSE_HEARTBEAT_MS` and `SSE_MAX_CONNECTIONS` bound the live stream. The
heartbeat is what keeps an idle stream from being cut off by a proxy between the
client and the instance, so lower it only if the proxy timeout is lower;
15 seconds is comfortably inside the ~60 seconds Render and most CDNs allow.
The connection cap is a memory guard, not a security control: each open stream
is a socket and a subscription held for as long as the client keeps it, so
`SSE_MAX_CONNECTIONS` is how many the process will hold before answering
`503 stream_full`. A client that hits the cap retries — which is why
`GET /stream` is best-effort by design and the JSON routes stay the source of
truth. A free-tier instance with a handful of dashboards does not need many.

## Running the indexer and the API separately

One process runs both by default (`npm start`). That is the right shape for a
single small deployment: fewer moving parts, and the one-click Render blueprint
assumes it.

Split them when the API and the indexer have different scaling or failure needs
— bursty API traffic alongside steady indexing, or more than one API replica.
The entry points are:

```bash
npm run start:api        # HTTP API only, no indexer
npm run start:indexer    # indexer only, no HTTP server
```

In development, `npm run dev:api` and `npm run dev:indexer` are the same split
with a watch loop. The indexer holds the cursor lease, so extra replicas are
safe: one indexes, the others log standby and retry. That also means combined
mode can be scaled to several replicas without racing — but it wastes the
standby replicas, which is the case for splitting.

`render.yaml` carries a commented two-service example. A background worker
needs a paid instance type, so the free-tier blueprint stays combined.

## Deploying

Suited to a platform that runs long-lived processes with a database attached, such as Render.

- Runtime: Node 22
- Build: `npm ci && npx prisma generate && npm run build`
- Start: `npm run db:migrate && npm start` (or `npm run start:api` / `npm run start:indexer` when split)
- Run `./scripts/use-postgres.sh` before `prisma generate` to switch the schema from `sqlite` to `postgresql`
- Provision the database in the **same region** and use its internal connection string

### Schema changes and migrations

Local development uses SQLite and `npx prisma db push`; nothing to do there. Production uses Postgres and **versioned migrations** in `prisma/migrations/`, applied on every start by `npm run db:migrate` (`prisma migrate deploy`).

To change the schema:

1. Edit `prisma/schema.prisma` (keep `provider = "sqlite"` in the committed file).
2. Against a scratch Postgres, run `./scripts/use-postgres.sh`, then `npx prisma migrate dev --name <change>`, and restore the provider to `sqlite` (`git checkout -p prisma/schema.prisma`, or edit it back).
3. Commit the new `prisma/migrations/<timestamp>_<change>/` directory with the schema change.

CI applies every migration to a fresh Postgres and then runs `prisma migrate diff`, failing the build if the schema and the migrations disagree.

**Existing database created with `db push`:** the first migration creates tables that already exist, so mark it as applied once, then deploy normally:

```bash
npx prisma migrate resolve --applied 20260101000000_init
npm run db:migrate
```

A new, empty database needs nothing special.

## Operations

- **Metrics**: `GET /metrics` is Prometheus text (not rate limited). Alert on `indexer_lag_ledgers` and `indexer_seconds_since_success`; both are set by the process running the indexer. `stream_connections` is the number of `GET /stream` clients this process is holding, so `rate-limited`-looking `503 stream_full` responses can be seen before they happen; it only moves in the process that serves the streams (combined mode, or the API in a split deployment).
- **Failed events**: an event the indexer cannot project is stored in the `FailedEvent` table and `/ready` reports degraded until it is cleared. After fixing the cause, run `npm run indexer:retry-failed`; it exits non-zero while any event still fails.
- **Reconciliation**: the read model is a cache of the chain, so run `npm run indexer:reconcile` on a schedule. It reads `get_voucher` for every non-terminal voucher (plus a rolling sample of settled ones, `--sample`, default 25) and records each disagreement in `ReconcileMismatch`. `/ready` reports `checks.reconcileMismatches` and `checks.reconcile: "drift"`, but stays 200: unlike a failed event, drift says nothing about whether this instance can serve traffic. `--fix` rewrites the differing rows from chain state, which is the only safe direction. The command exits non-zero while any mismatch is open.
- **Faucet usage**: with `FAUCET_CONTRACT_ID` set, `dripped` events are indexed into `FaucetDrip` and `/stats` reports `faucetDrips` (total) and `faucetWallets` (distinct wallets) — the closest thing to a count of people who tried the demo.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). It documents the one trap this codebase has already hit: contract event fields marked `#[topic]` arrive in the topic list, not the data map, and reading them off the data map corrupts rows silently rather than crashing.

Security reports go through [SECURITY.md](SECURITY.md).

## Contributors

<a href="https://github.com/Godgift-care/sci-healthcare-backend/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Godgift-care/sci-healthcare-backend" />
</a>

## License

Apache-2.0. See [LICENSE](LICENSE).
