# Shipping logs to an external service

The dashboard's log explorer is enough to watch a deploy. It is not enough
for an incident: Render keeps logs for a limited window that depends on the
workspace's retention period, and the free tier's window is measured in
hours, so by the time someone asks "what happened last Tuesday?" the lines
are gone. This guide sets up a log stream so they are not.

It is deliberately about **logs only**. Metrics (`/metrics`, see
`ops/grafana-dashboard.json`), alerting (`ops/alerts.yml`) and health
(`/ready`) answer "is it broken now"; logs are the only one of the four that
can answer "what exactly happened in that request or that ledger". The
uptime monitor and the alerting rules are described in
[RUNBOOK.md](RUNBOOK.md#uptime-monitoring) and [alerts.yml](../ops/alerts.yml).

## What the service already emits

Everything goes to **stdout as one JSON object per line** (pino), which is
what a log shipper wants: no multi-line stack traces to re-assemble, no
parsing rules beyond "each line is JSON".

A finished request looks like this (`LOG_LEVEL=info`):

```json
{"level":30,"time":1761033600123,"pid":1,"hostname":"srv-abc","reqId":"5b0f2a1e-8a3c-4f2b-9d47-2f9b1c0e77aa","req":{"method":"GET","url":"/v1/vouchers?provider=GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK","version":null,"host":"sci-healthcare-api.onrender.com","remoteAddress":"203.0.113.7","remotePort":54321},"res":{"statusCode":200},"responseTime":12.4,"msg":"request completed"}
```

The indexer and the webhook delivery loop write their own lines in the same
shape, with the fields that make a failure reproducible:

```json
{"level":50,"time":1761033605123,"reqId":null,"err":{"type":"Error","message":"soroban rpc unreachable"},"msg":"indexer poll failed"}
{"level":40,"time":1761033609123,"id":"0b34…","url":"https://clinic.example/hooks","attempts":2,"error":"HTTP 500","abandoned":false,"msg":"webhook delivery failed"}
```

Set `LOG_LEVEL` (`debug`, `info`, `warn`, `error`) per environment: `info` in
production, `debug` only while chasing something specific, because every
level you add is ingested and billed.

## Fields worth indexing

Index these at the provider, in this order. Everything else is still
searchable as text; these are the fields you will filter on under pressure.

| Field | Where it appears | Why it is worth an index |
| --- | --- | --- |
| `reqId` | request, error and rejection lines | The correlation id. It is echoed as `X-Request-Id`, so a user's report carries the handle to their exact log lines |
| `req.url` | request lines | The route and its filters, with `beneficiaryRef` already masked (see below) |
| `res.statusCode` | request lines | Separates "the user got a 500" from "the user got a 404" without opening the body |
| `responseTime` | request lines | Slow requests, in milliseconds; the API's own latency, without a metrics round trip |
| `level` | every line | pino's numeric level; alert on `>=50` (error) rather than on keywords |
| `msg` | every line | The event name (`request completed`, `indexer poll failed`, `webhook delivery failed`), stable and cheap to group by |
| `ledger` | indexer and webhook lines | The ledger an event came from, which is the unit of replay (`npm run indexer:backfill -- --from <ledger>`) |
| `txHash` / `voucherId` | indexer, webhook lines | The on-chain proof and the row it touched; both are public |
| `attempts` / `abandoned` | webhook lines | Distinguishes "retrying" from "given up on" without parsing the message |
| `err.message` (and `err.stack`) | error lines | The only place a 5xx cause is recorded — the API responds `internal_error` and keeps the cause here |

Two deliberate exclusions:

- **`beneficiaryRef` is never logged.** The request serializer masks it to
  `beneficiaryRef=%5Bredacted%5D` before the line is written
  (`src/lib/log-redaction.ts`, `src/__tests__/log-redaction.test.ts`), because
  the reference is a stable patient pseudonym and logs are retained longer
  and shared more widely than the database. Do not add it as a field, and do
  not "fix" the mask.
- **Request and response bodies are not logged.** Nothing in this API needs
  them, and they would be the one place patient data could leak into a
  third-party service.

`req.remoteAddress` is an IP address. Treat it as personal data: choose the
shortest retention that still covers an incident, and do not hand the log
account to anyone who does not already have database access.

## 1. Point Render at a destination

Log streaming is configured once per workspace and then applies to every
service, including the free-tier web service this project deploys to. Render
documents per-service overrides (a different destination, or omitting one
service) as a Pro-or-higher feature; the workspace default is all this
project needs. Log streaming traffic does not count against outbound
bandwidth.

1. In the Render Dashboard, open **Integrations → Observability**.
2. Under **Log Streams → Default destination**, click **+ Set default**.
3. Fill in **Log Endpoint** and **Token** from one of the recipes below.
   - Syslog endpoints use the form `HOST:PORT`.
   - HTTPS endpoints use the full URL.
4. Save, then deploy nothing — the stream picks up the running instance.

Render sends syslog as RFC 5424 over TLS (TCP 6514 for the providers below)
and maps pino's `level` onto a syslog priority, so severity survives the
hop.

## 2. Recipe: Better Stack

Better Stack has a first-class Render source, so the endpoint and token come
from one screen.

1. In Better Stack, open **Telemetry → Sources → Connect source**.
2. Name it `sci-healthcare-backend`, choose the **Logs** tab, platform
   **Render**, and connect.
3. Copy the source's **ingesting host**, append port `6514` — for example
   `s1234567.eu-north-1.betterstack.com:6514` — into Render's **Log
   Endpoint**.
4. Copy the **source token** into Render's **Token**. It is the credential;
   do not paste it into this repository.
5. Lines appear under **Logs & traces** within a few minutes.

The free plan is sized for a service that emits a few thousand lines a day
at `LOG_LEVEL=info`; check the current limits before turning on `debug`.

## 3. Recipe: Axiom

Axiom has no Render-native source, but it accepts syslog over TLS, which is
one of the two transports Render speaks. Unlike Better Stack, the token is
the endpoint URL itself — treat it as a secret.

1. In Axiom, create a dataset (for example `sci-healthcare`) and an API
   token that can ingest into it.
2. Open **Settings → Endpoints → New endpoint → Secure Syslog**, name it,
   select the dataset, and copy the target URL it shows
   (`https://<subdomain>.ingress.axiom.co`).
3. In Render's **Log Endpoint**, enter the host from that URL with port
   `6514`: `<subdomain>.ingress.axiom.co:6514`.
4. Leave Render's **Token** empty — Axiom's syslog endpoint does not take
   one, which is why the URL must be kept secret.
5. Optionally add a saved query for `level >= 50` and one for
   `msg == "webhook delivery failed"`; those are the two lines that
   matter in an incident.

Any other provider with a TLS syslog endpoint works the same way
(Papertrail, Coralogix, New Relic, Loggly, Mezmo, Sumo Logic). Render's
[log streams documentation](https://render.com/docs/log-streams) lists the
per-provider endpoints.

## 4. Verify it end to end

Do not trust "logs are flowing" from a green toggle. Prove that one request
in the API is one line in the provider, using the correlation id the API
already promises:

```bash
# 1. Ask the API for a request id.
curl -s -D - -o /dev/null https://sci-healthcare-api.onrender.com/v1/stats \
  | tr -d '\r' | awk -F': ' 'tolower($1)=="x-request-id"{print $2}'
```

```bash
# 2. Search the provider for that exact value.
#    Better Stack: paste it in the search box.
#    Axiom:        ['sci-healthcare'] | where reqId == "<the id>"
```

You should find the `incoming request` and `request completed` lines for
that id, with the same `res.statusCode` the `curl` returned. If the id is
missing, the stream is not attached to this service (check the workspace
default destination and that the service is not excluded by an override).

Two more checks worth doing once:

- **A 5xx arrives with its cause.** `curl` a voucher id that does not exist
  (`404`) and confirm one line with `res.statusCode: 404`; a real 5xx is rare
  by design, but `err.type` / `err.message` is where it will be.
- **The mask survived the hop.** Search for `beneficiaryRef=` and confirm
  every hit reads `beneficiaryRef=%5Bredacted%5D`. If a raw reference shows
  up, the deployment is running an old build — check `/version` for the
  commit.

## 5. Retention, cost and what to do with the data

- Keep **at least 14 days**: long enough to cover "it broke over the
  weekend", short enough to stay inside the free tier.
- Logs are **not** a monitoring system. Paging belongs to
  `ops/alerts.yml` (indexer lag, stalled indexer, failed events, 5xx rate,
  webhook backlog) and to the readiness probe in
  [RUNBOOK.md](RUNBOOK.md#uptime-monitoring); the log service is where you
  go *after* one of those fires.
- The database stays a projection of the chain: nothing in the logs is a
  source of truth. A promoted incident write-up should quote the `reqId`,
  the `ledger` and the `txHash`, because those three are enough to replay
  or reconcile whatever went wrong (`docs/RUNBOOK.md`).
- If the service is moved off Render, the same rules apply to any container
  runtime: `docker compose logs -f` for a desk-side look, and a syslog
  driver for anything that has to survive the container.
