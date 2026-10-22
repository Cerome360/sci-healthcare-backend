# Runbook

## Backing up and restoring the database

The database is a projection of the chain, never a source of truth: every
row can be rebuilt by replaying ledger events (see `prisma/schema.prisma`
and the full-reindex procedure under "Indexer falls outside the RPC
retention window" below). A backup therefore buys *time*, not data
survival — it saves a slow re-index, and beyond the RPC retention window
(~7 days on testnet) it is the only way back to a complete read model
without waiting for the chain to catch up.

It also contains no patient records: the most sensitive column is
`beneficiaryRef`, an opaque 32-byte commitment that is already public on
chain (`docs/privacy.md`). Backups still deserve the same care as the
database itself, because they make bulk correlation of that public data
easier than the rate-limited API does. Keep them private and rotate them.

### Production (Render Postgres)

**Automatic backups.** Render's managed Postgres (`sci-healthcare-db` in
`render.yaml`) takes daily backups; the actual retention for the current
plan is listed under the database's **Backups** tab in the dashboard.
Restoring from one creates a *new* database instance (a fork), so plan a
service restart after the swap; the running web service picks up the new
connection string because `DATABASE_URL` comes from the database via
`render.yaml`.

**A second copy off Render (`pg_dump` on a cron).** A custom-format dump
is compressed, portable, and restorable into any Postgres. On any machine
that can reach the internal connection string (the Render shell on the
service works), install a nightly job:

```cron
# /etc/cron.d/sci-db-backup — 03:15 UTC nightly, keep 14 days
15 3 * * * backup /usr/bin/pg_dump --format=custom --no-owner \
  --dbname="$DATABASE_URL" "/backups/sci-$(date +\%F).dump" \
  && /usr/bin/find /backups -name 'sci-*.dump' -mtime +14 -delete
```

Run it with `PGSSLMODE=require` (Render's connection string already
requires TLS) and verify at least one restore per quarter — a backup
nobody has restored is a rumour.

**Restore from a dump** into a fresh database:

1. Create an empty Postgres database (Render dashboard, or a scratch
   instance — never overwrite the live one in place).
2. `pg_restore --no-owner -d "$NEW_DATABASE_URL" /backups/sci-YYYY-MM-DD.dump`
3. Point `DATABASE_URL` at it and restart the service. `npm run db:migrate`
   runs on boot (`render.yaml` startCommand), so an older dump is
   migrated up to the current schema before the indexer resumes.
4. The indexer resumes from the `IndexerState.lastLedger` cursor inside
   the restored data. If that cursor is older than the RPC retention
   window, the service goes degraded on `/ready` — follow "Indexer falls
   outside the RPC retention window" below.

### Local development (SQLite)

The default datasource is a SQLite file (`prisma/schema.prisma`). Back it
up with the `sqlite3` online-backup command while nothing is writing, or
with a plain file copy when the server is stopped:

```bash
sqlite3 prisma/dev.db ".backup /backups/dev-$(date +%F).db"
# or, with the dev server stopped:
cp prisma/dev.db /backups/dev-$(date +%F).db
```

Restore is the copy in the other direction. Delete the file first so a
stale `-wal`/`-journal` file cannot shadow it, then start the server.

### Restore drill — results

- **2026-10-18, local SQLite (tested).** Created a scratch database with
  `npx prisma db push`, seeded one provider, one voucher and an indexer
  cursor of ledger 12345, took a cold file copy of the closed database,
  deleted the original, restored the copy and reopened it. Result:
  `PRAGMA integrity_check` → `ok`, provider count 1, voucher count 1,
  cursor 12345 — the read model came back byte-for-byte. The Postgres
  procedures above follow Render's documented managed-DB behaviour but
  were not executed against the live instance from the dev machine (no
  local Postgres toolchain); a maintained drill of the `pg_restore` path
  against a scratch Render fork is tracked by this runbook's own
  "verify at least one restore per quarter" rule.

### Full reindex (no backup, or a backup you do not trust)

Because the chain is the source of truth, a lost database is recoverable
without any backup at all, as long as the events are still within RPC
retention:

1. Create an empty database (`prisma migrate deploy` for the schema).
2. Set `INDEXER_START_LEDGER` to the oldest deployment ledger — the
   `fromLedger` of the earliest row in the `Deployment` table, or the
   deploy ledger recorded in `render.yaml` / the README when the table is
   empty.
3. Start the indexer. It replays every event from that ledger forward;
   handlers are idempotent, so replaying is safe even if some rows
   survived.
4. When the cursor reaches the chain tip, spot-check the rebuild against
   the chain with `npm run indexer:reconcile` (report only; exit 2 means
   drift — see "The database disagrees with the chain" below).

For an *existing* database that fell outside retention rather than being
lost, see "Indexer falls outside the RPC retention window" below.

## Indexer falls outside the RPC retention window

Soroban RPC retains roughly seven days of ledgers on testnet. If the
indexer is offline longer than that, its cursor points at a ledger the
RPC no longer has. The indexer detects this on the next cycle, marks
itself **degraded** (`gap = true` in `IndexerState`), and `/ready`
returns **503** with the gap details.

### Symptoms

- `/ready` returns 503 with `checks.indexer = "gap"`.
- The `checks.gap` object shows `cursorLedger` (where the indexer was)
  and `oldestAvailable` (the oldest ledger the RPC still has).

### Recovery options

#### Option A — Restore a database snapshot

If you have a database backup taken while the indexer was still within
the retention window:

1. Restore the backup.
2. Restart the indexer. It will resume from the snapshot's cursor.

#### Option B — Accept the gap and resume

If no snapshot is available and you can tolerate missing events in the
gap:

1. Update the cursor to the oldest available ledger:
   ```sql
   UPDATE IndexerState
   SET lastLedger = <oldestAvailable from /ready>,
       gap = false,
       gapOldestLedger = NULL,
       gapCursorLedger = NULL
   WHERE id = 1;
   ```
2. Restart the indexer. It picks up from the new cursor.
3. Events between the old cursor and the new one are permanently lost.

#### Option C — Full reindex

If the deploy ledger is within the retention window:

1. Delete the database.
2. Set `INDEXER_START_LEDGER` to the deploy ledger.
3. Start the service. The indexer rebuilds the read model from scratch.

## The RPC is failing

The indexer backs off exponentially after a failed cycle (doubling from
`INDEXER_POLL_MS` up to `INDEXER_BACKOFF_MAX_MS`, with jitter) and logs
the failure once per streak, not once per attempt. An outage therefore
looks like one `indexer poll failed` error followed by silence, then
`indexer recovered` with the number of attempts it took.

### Symptoms

- One `indexer poll failed` in the log, and `indexer_seconds_since_success`
  climbing in `/metrics`.
- `/ready` eventually reports `indexer: "lagging"` once the cursor trails
  by more than `READY_MAX_LAG_LEDGERS`.

### What to do

1. Check which endpoint is in use: `checks.rpcUrl` on `/ready`, or
   `rpcUrls` on `/version` for the whole configured list.
2. If only one endpoint is configured, add a second to
   `SOROBAN_RPC_URLS` (comma-separated) and restart. After
   `SOROBAN_RPC_MAX_FAILURES` consecutive failures the backend moves to
   the next endpoint and logs
   `soroban rpc endpoint failing; switching to the next one`.
3. The backoff resets itself on the first cycle that works. Nothing has
   to be cleared by hand, and no events are skipped: the cursor only ever
   advances after a batch commits.

If the outage outlasts the RPC retention window, this becomes the
retention-gap procedure above.

## The database disagrees with the chain

A missed or mis-decoded event leaves the read model quietly wrong, and
the poll loop will never notice because it only moves forwards.

```bash
npm run indexer:reconcile              # report only; exits 2 if drift is open
npm run indexer:reconcile -- --sample 200   # deeper spot-check of settled rows
npm run indexer:reconcile -- --fix     # rewrite differing rows from chain state
```

Every non-terminal voucher is compared against `get_voucher`, plus a
rolling sample of terminal ones (least recently updated first, so repeated
runs cover the history). Differences are written to `ReconcileMismatch`
and surfaced on `/ready` as `checks.reconcileMismatches`; the row is
deleted as soon as a run sees the voucher agree.

### Symptoms

- `/ready` reports `reconcile: "drift"` with a non-zero
  `reconcileMismatches` (still HTTP 200 — drift does not stop the API
  serving).
- `reconcile: voucher disagrees with chain` in the log, with the
  differing fields.

### What to do

1. Read the `fields` column of the mismatch row: it is a JSON array of
   `{ field, db, chain }`.
2. If the same field is wrong across many vouchers, it is a decoder bug —
   fix `src/stellar/events.ts` and `TOPIC_FIELDS` first, then replay the
   affected range with `npm run indexer:backfill -- --from <ledger>`.
3. For a handful of rows, `--fix` rewrites them from chain state. It only
   ever writes the chain's values into the database; this service cannot
   change the chain.
4. `kind: "missing_on_chain"` means the database has a voucher the
   contract has never heard of. `--fix` deliberately leaves those alone:
   it points at a wrong `VOUCHER_CONTRACT_ID` or a database restored from
   another network, which deleting rows would only hide.

## Webhook deliveries are stuck

Webhooks are optional (`WEBHOOK_URLS`), and the outbox is separate from the
indexer on purpose: a slow clinic endpoint must never stall the cursor. The
cost is that a broken delivery path does not fail anything else — the
indexer keeps indexing and the API keeps serving while clinics stop being
told about voucher events. `/ready` is what makes that visible.

### Symptoms

- `/ready` returns 503 with `checks.webhooks.state = "backlog"` and
  `oldestPendingAgeSeconds` beyond `maxPendingAgeSeconds`
  (`READY_WEBHOOK_MAX_AGE_MS`, 15 minutes by default).
- `checks.webhooks.abandoned` above zero: those deliveries were given up on
  and will never be retried.
- The `SciWebhookBacklog` alert (`ops/alerts.yml`) fires when
  `webhook_deliveries_pending` has stayed above zero for fifteen minutes;
  `SciWebhookDeliveriesAbandoned` fires on the abandoned count.

### What to do

1. **Is the delivery loop running?** It runs in the process that starts the
   dispatcher (combined mode, or the API process in a split deployment);
   look for `webhook delivery started` at boot and a recent
   `webhook delivery cycle failed` if it is erroring. A process with no such
   line at all has webhooks disabled — check `WEBHOOK_URLS` and
   `WEBHOOK_SECRET`.
2. **Is it the endpoint?** The log line `webhook delivery failed` carries
   `url`, `attempts`, `error` and `abandoned`. `HTTP 5xx`, `408` and `429`
   are retried; any other 4xx is permanent and abandons the delivery
   immediately. Fix the receiver, not this service: there is no way to make
   a clinic's endpoint accept a payload.
3. **Nothing is stuck, but the count is old.** Rows that were delivered or
   abandoned never disappear, and only pending rows affect `/ready`. If a
   backlog was cleared by hand and the gauge has not moved yet, wait one
   delivery interval (the loop scans the outbox every five seconds).
4. **Recovering a missed notification.** The events are still on chain and
   in `GET /vouchers/:id/events`; a receiver that comes back up should be
   pointed at the API, not replayed from the log. `txHash` and `ledger` in
   the failed line identify exactly what was missed.

Disabling webhooks (`WEBHOOK_URLS` empty) makes `/ready` report
`checks.webhooks.state = "disabled"` and stop degrading, which is what you
want only if you have decided those notifications are not being delivered at
all. Pending rows from before are then never drained.

## Uptime monitoring

Two layers watch the deployed service, and they answer different questions:

| Layer | Watches | Raises |
| --- | --- | --- |
| The `Uptime monitor` GitHub workflow (committed in this repo) | `/ready` every 30 minutes | A failed run and a red README badge |
| An external monitor (UptimeRobot below) | `/ready` every 5 minutes | Email to the alert contact |
| Prometheus rules in `ops/alerts.yml` | `/metrics` series | Indexer lag or stall, failed events, 5xx rate, webhook backlog |

Neither of these can see the service get *slow*; they only prove `/ready`
stays green. A paging on latency would need response-time alerting, which
is outside the free plans this project runs on.

### The scheduled GitHub workflow

`.github/workflows/monitor.yml` curls
`https://sci-healthcare-api.onrender.com/ready` every 30 minutes, retrying
three times with a 120-second timeout so a Render free-tier cold start
(~30–60 s) does not fail the run. A red run means `/ready` did not return
2xx for several minutes, and the `Uptime monitor` badge in the README is
red from the moment the failing run is reported until a run passes again.

Two caveats, and the reason this is a backstop rather than the alerting
mechanism:

- Scheduled workflows can start several minutes late when GitHub's
  scheduler is busy.
- GitHub disables scheduled workflows after 60 days of repository
  inactivity. If the badge has not moved in weeks, check the Actions tab
  and re-enable the workflow.

### Setting up the external monitor (UptimeRobot, free plan)

The free plan covers a single monitor at a 5-minute interval with email
alerts, which is all this needs:

1. Create an account at <https://uptimerobot.com> and log in.
2. **Add New Monitor** → monitor type **HTTP(s)**.
3. Friendly name: `SCI Healthcare API`.
4. URL: `https://sci-healthcare-api.onrender.com/ready`
5. Monitoring interval: **5 minutes**.
6. Keep the expected status at `200` and the default alert threshold. The
   monitor should now appear on the dashboard with its status.
7. **Alert contact**: the maintainer listed in the README's Maintainers
   section ([@adelekevat](https://github.com/adelekevat)) — use that
   maintainer's email address so alerts land with the person who can act
   on them. The free plan includes email alerts; add more contacts in
   **My Settings → Alert Contacts** if that changes.

### Why `/ready` and not `/health`

`/health` is liveness: it proves the process answers HTTP, nothing else. An
API whose indexer silently stopped advancing, whose database has gone away,
or whose RPC is unreachable still returns `200` on `/health`. `/ready` runs
the real dependency checks — database, RPC, indexer lag against
`READY_MAX_LAG_LEDGERS`, retention gap, failed events, webhook backlog
against `READY_WEBHOOK_MAX_AGE_MS` — and returns **503** with the failing
check named. A 503 from this endpoint is a real alert, not a
transient failure to filter out.

### Cold-start false positives on Render's free tier

The service sleeps after ~15 minutes idle and the first request pays 30–60
seconds of wake-up time. Two consequences:

- Keep the monitor's timeout at 60 seconds or longer. A 5-second timeout
  will mark a healthy-but-waking service as down.
- Even with retries, expect the occasional recovery alert around a wake-up.
  If that becomes noisy, raise the alert threshold so two consecutive
  failed checks are needed before alerting — a real outage fails many
  checks in a row. Do not fix the noise by lengthening the interval; that
  only delays the real alert.

### Optional: swap the README badge to the external monitor

The README ships with the GitHub workflow badge because it works with no
account. Once an UptimeRobot monitor exists, shields.io can render its
status instead — see the monitor's **Settings** for its monitor-specific
API key and the shields.io `uptimerobot` badge URL — and the workflow
badge block in `README.md` can be replaced with it.
