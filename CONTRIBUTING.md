# Contributing to SCI Healthcare Backend

This service indexes Soroban contract events into a queryable read model and
serves them over a read-only HTTP API.

## Setup

Use Node 22 (`nvm use` reads `.nvmrc`). Its bundled npm 10 is what CI runs;
a lockfile written by npm 11 drops entries npm 10 requires and fails `npm ci`.

```bash
npm install
cp .env.example .env        # fill in contract ids from the contracts repo
npx prisma generate
npx prisma db push
npm run dev
```

You need contract ids from a deployment. Either run `scripts/deploy.sh` in
`sci-healthcare-contracts`, or use the testnet addresses in that repo's README.

```bash
npm run typecheck
npm test
```

### Seeding local data

A fresh database is empty until the indexer catches up, which makes UI work
slow. `npm run db:seed` fills it with deterministic fake data — clinics in
each status, service catalogues, vouchers in every lifecycle status, and
receipts for the settled ones — so every list route has something to show:

```bash
npm run db:seed                      # 12 clinics, ~2 500 vouchers
SEED_VOUCHERS=100000 npm run db:seed # stress-sized seed for query-plan work
```

The seed is defined in `prisma/seed.ts` (entry) and `src/scripts/seed.ts`
(data generation). Two guards keep it honest:

- It **refuses to run** unless `DATABASE_URL` is a SQLite file or a Postgres
  on `localhost`/`127.0.0.1`/`::1`. Fabricated rows are fine in a local
  projection; everywhere else the read model must mirror the chain.
- It only ever writes and deletes its own reserved id space (voucher ids
  from 9 000 000 000 000, addresses prefixed `GSEED`), so it cannot clobber
  indexed on-chain data. Re-running it resets those rows and ends on the
  same state, at any voucher count.

### Checking the read model against the chain

The database is a cache. `npm run indexer:reconcile` reads `get_voucher` for
every non-terminal voucher and reports any row that disagrees with the
contract; `-- --fix` rewrites those rows from chain state. Run it after
touching a handler or the decoder — a projection bug usually shows up there
before anyone notices it in the API.

### Optional: pre-commit lint hook

Run `npm install` once and the `prepare` script installs a git pre-commit hook
that runs ESLint on staged files. This catches lint errors locally before CI.
The hook is optional — contributors who prefer not to use it can skip it, but
CI still enforces the same rules.

## Non-negotiables

- **The database is a projection, never a source of truth.** Deleting it and
  replaying from the deploy ledger must reproduce it exactly. Do not add a
  column that cannot be derived from on-chain events.
- **This service is read-only and holds no keys.** It never signs or submits a
  transaction. Every write is signed in the user's wallet. Any PR that adds a
  signing key to this service will be rejected.
- **Never store patient-identifying data.** Only the opaque `beneficiaryRef`.
  Nothing may be written here that is not already public on chain.
- **i128 amounts are strings, never numbers.** `Number` silently loses precision
  above 2^53. Use `BigInt` for arithmetic and store decimal strings.
- **Event handlers must be idempotent.** The indexer replays on crash, so use
  upserts keyed by on-chain id.

## Decoding events

The trap this codebase has already hit once: fields marked `#[topic]` in the
Rust event struct are published in the event's **topic list**, not in its data
map. Reading them off the data map yields `undefined`, which then stringifies
into the database as the literal text `"undefined"` — a silent corruption, not a
crash.

`TOPIC_FIELDS` in `src/stellar/events.ts` restores names onto positional topic
values and **must** be kept in step with the contracts. If you add an event or
move a field between topic and data, update that map in the same change and add
a case to `src/__tests__/events.test.ts`.

## Commits and PRs

Conventional commits, one logical change each:

```
feat(api): filter vouchers by expiry window
fix(indexer): advance the cursor only after a batch commits
test(events): cover an event with no data fields
```

- `npm run typecheck` and `npm test` must pass.
- New endpoints need a test and a README entry.
- Endpoints that return user data must require a specific filter. An unfiltered
  dump invites scraping and will not be merged.

## How pull requests are merged

A bot merges pull requests automatically (squash) as soon as every CI check on the latest commit has passed, provided the pull request:

- is not a draft and has no `do-not-merge` label,
- links the issue you were assigned on Drips Wave, with a line such as `Closes #123` in the description (Wave points are awarded when that issue is closed as completed, which the bot does on merge),
- has no merge conflicts and is up to date with `main` (the bot comments if it is behind),
- and, if it changes anything under `.github/` (CI workflows and repository automation), has been approved by a maintainer. The bot comments with the files that need approval.

So open your pull request as a draft until it is ready, and keep CI green. To stop an automatic merge, add the `do-not-merge` label or convert the pull request back to a draft.

## Wave program

Issues carry `trivial` (100), `medium` (150) or `high` (200) complexity labels.
Read the [Wave rules](https://docs.drips.network/wave/terms-and-rules/); untested
or unreviewed LLM output is explicitly disallowed.
