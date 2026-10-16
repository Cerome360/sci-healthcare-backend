# Runbook

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

## Uptime monitoring

Two layers watch the deployed service, and they answer different questions:

| Layer | Watches | Raises |
| --- | --- | --- |
| The `Uptime monitor` GitHub workflow (committed in this repo) | `/ready` every 30 minutes | A failed run and a red README badge |
| An external monitor (UptimeRobot below) | `/ready` every 5 minutes | Email to the alert contact |

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
`READY_MAX_LAG_LEDGERS`, retention gap — and returns **503** with the
failing check named. A 503 from this endpoint is a real alert, not a
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
