<p align="center">
  <img src="docs/banner.png" alt="SCI Healthcare" width="640" />
</p>

<p align="center">
  <a href="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/ci.yml">
    <img src="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/node-22-green" alt="node 22" />
  <img src="https://img.shields.io/badge/fastify-5.12-black" alt="fastify" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="Apache 2.0" />
</p>

# SCI Healthcare — Indexer &amp; API | [Documentation](https://godgift-care.github.io/sci-healthcare-contracts/)

> **Live:** [App](https://sci-healthcare.vercel.app) · [API](https://sci-healthcare-api.onrender.com/stats) · [Docs](https://godgift-care.github.io/sci-healthcare-contracts/) · [Contracts on testnet](https://stellar.expert/explorer/testnet/contract/CBPUQN6CNJCNGPKNEXB7UM4T7RINKQB7HQI5CXEOSQ5EFRHE4G4VKPSQ)
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

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness |
| `GET /ready` | Readiness, including how many ledgers the indexer trails the chain by |
| `GET /stats` | Protocol counters for the dashboard |
| `GET /providers` | Verified clinics, filterable by `status`, `country`, `q` |
| `GET /providers/:address` | One clinic and its service catalogue |
| `GET /vouchers` | Vouchers by `funder`, `provider`, `beneficiaryRef`, `status`, a `createdFrom`/`createdTo` window or a `minAmount`/`maxAmount` band |
| `GET /vouchers/:id` | One voucher, with its care receipt if settled |
| `GET /receipts?beneficiaryRef=` | A patient's settled care history |

`GET /vouchers` **requires at least one filter**. An unfiltered dump of every voucher is not a useful endpoint and invites scraping.

`createdFrom` and `createdTo` are ISO 8601 timestamps and filter on `createdAt`. `minAmount` and `maxAmount` are i128 base-unit strings and are compared numerically, so `"9000000"` is correctly below `"10000000"`.

`/receipts` requires an exact `beneficiaryRef`. Because that value is an HMAC under a key held by the patient, the endpoint cannot be walked to enumerate people.

### Response behaviour

List routes (`/vouchers`, `/providers`, `/receipts`) are limited to 30 requests
per minute per client; other routes default to 120, while `/health` and `/ready`
are exempt so a struggling service can always be probed. JSON above 1 KB is
gzip-compressed when the client accepts it, and every response carries the
standard `@fastify/helmet` security headers (no CSP — this API serves JSON, not
HTML).

### Example

```bash
curl "http://localhost:8080/providers?status=Active" | jq
curl "http://localhost:8080/vouchers?provider=GDOOCNK2...ZKBK" | jq
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
      "services": [
        { "code": 101, "label": "Outpatient consult", "price": "30000000", "priceDisplay": "3.0000000" }
      ]
    }
  ]
}
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

| Variable | Purpose | Example |
| --- | --- | --- |
| `PORT` | HTTP port | `8080` |
| `HOST` | Bind address | `0.0.0.0` |
| `LOG_LEVEL` | pino level | `info` |
| `CORS_ORIGIN` | Comma-separated allowed origins | `http://localhost:3000` |
| `DATABASE_URL` | Resolved **relative to `prisma/`** | `file:./dev.db` |
| `SOROBAN_RPC_URL` | Soroban RPC endpoint | `https://soroban-testnet.stellar.org` |
| `NETWORK_PASSPHRASE` | Network passphrase | `Test SDF Network ; September 2015` |
| `REGISTRY_CONTRACT_ID` | Registry contract | `CAMU635NRFEHATJ6MTY5SI43IAZ43KHPFXAQDQAST2AHKCHLSGWHVE4V` |
| `VOUCHER_CONTRACT_ID` | Voucher escrow | `CBPUQN6CNJCNGPKNEXB7UM4T7RINKQB7HQI5CXEOSQ5EFRHE4G4VKPSQ` |
| `RECEIPT_CONTRACT_ID` | Care receipts | `CBCJRI2BCZBMZNX77WWDC2NGSV4ZNAN5Q23XHYNBH6UTOQMPJHZGX5C7` |
| `USDC_CONTRACT_ID` | Settlement token | `CCRLJ7FEIKTR3GBT3VQQPSIJGRBO2WPNMVFKJDP6AYGJQWECOR4QVE5M` |
| `INDEXER_START_LEDGER` | Ledger to index from; `0` means start at the tip | `4465529` |
| `INDEXER_POLL_MS` | Poll interval | `5000` |

Set `INDEXER_START_LEDGER` to the deployment ledger. Leaving it at `0` starts at the current tip and silently skips all prior history. Soroban RPC also only retains a rolling window of ledgers (about 7 days on testnet) — an indexer that falls further behind than the window cannot catch up, and `/ready` will say so rather than pretend otherwise.

## Deploying

Suited to a platform that runs long-lived processes with a database attached, such as Render.

- Runtime: Node 22
- Build: `npm ci && npx prisma generate && npm run build`
- Start: `npm run db:migrate && npm start`
- Switch `provider` in `prisma/schema.prisma` from `sqlite` to `postgresql`
- Provision the database in the **same region** and use its internal connection string

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). It documents the one trap this codebase has already hit: contract event fields marked `#[topic]` arrive in the topic list, not the data map, and reading them off the data map corrupts rows silently rather than crashing.

Security reports go through [SECURITY.md](SECURITY.md).

## Contributors

<a href="https://github.com/Godgift-care/sci-healthcare-backend/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Godgift-care/sci-healthcare-backend" />
</a>

## License

Apache-2.0. See [LICENSE](LICENSE).
