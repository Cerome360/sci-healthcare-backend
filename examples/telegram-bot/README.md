# Clinic Telegram Notification Bot

An example microservice demonstrating how clinics receive signed webhook notifications from the SCI Healthcare indexer and notify their staff via Telegram.

## Overview

In low-connectivity or high-volume healthcare settings, clinic staff cannot keep a dashboard open waiting for new patients. When a new voucher is funded on Stellar or progresses through its lifecycle (funded, claimed, attested, settled, refunded), the backend indexer dispatches a signed webhook.

This bot:
1. **Verifies HMAC-SHA256 signatures** (`X-SCI-Signature`) using the shared `WEBHOOK_SECRET` with constant-time equality checks to prevent forgery and timing attacks.
2. **Protects patient privacy**: Never includes patient identifiers, beneficiary keys, or beneficiary HMAC references. Any payload containing beneficiary references is strictly rejected.
3. **Notifies clinic staff** in real time via the Telegram Bot API so doctors and triage nurses can promptly examine patients and submit claims.

## Architecture & Privacy Guarantee

```
+--------------------------+       Signed Webhook (HMAC-SHA256)        +--------------------------+       Telegram Bot API       +---------------------+
|  SCI Healthcare Indexer  | ---------------------------------------> |   Clinic Telegram Bot    | ---------------------------> | Clinic Telegram Chat|
|                          |   Headers: X-SCI-Signature: <hex>        |   (Verifies signature &  |      HTML Notification       |  (Doctors & Staff)  |
+--------------------------+   Body: { voucherId, status, amount }    |    privacy assertions)   |                              +---------------------+
                                                                      +--------------------------+
```

> **Strict Privacy Requirement:**
> The webhook payload and clinic notifications **NEVER** expose beneficiary HMACs, patient IDs, or medical secrets. Only public on-chain identifiers (`voucherId`, `status`, `amount`, `serviceCode`) are communicated.

## Requirements

- Node.js >= 20.11
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather)
- A Telegram Chat ID (group or direct channel with clinic staff)

## Configuration

Set the following environment variables:

| Variable | Description | Default |
|---|---|---|
| `PORT` | Local HTTP port to listen for incoming webhooks | `3001` |
| `WEBHOOK_SECRET` | Secret shared with the indexer to verify `X-SCI-Signature` | `example-webhook-secret-do-not-use-in-prod` |
| `TELEGRAM_BOT_TOKEN` | Token provided by @BotFather | `mock-token` (logs to stdout if unset) |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for clinic notifications | `12345678` |

## Running Locally

### 1. Build and Start the Service

```bash
# From repository root:
npx tsx examples/telegram-bot/src/index.ts
```

The service will start listening:
```
Clinic Telegram Webhook Bot running at http://localhost:3001/webhook
Listening for signed voucher notifications (HMAC-SHA256)
```

### 2. Send a Test Webhook

To simulate the backend indexer sending a signed notification, generate the HMAC-SHA256 signature and post to `/webhook`:

```bash
SECRET="example-webhook-secret-do-not-use-in-prod"
PAYLOAD='{"event":"voucher_funded","voucherId":"0001","status":"Funded","amountDisplay":"3.0000000","serviceCode":101,"serviceLabel":"Outpatient consult","ledger":12345}'

# Compute HMAC-SHA256 signature
SIG=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

# Dispatch webhook
curl -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -H "X-SCI-Signature: $SIG" \
  -d "$PAYLOAD"
```

Expected response:
```json
{"ok":true,"status":"delivered","voucherId":"0001"}
```

### 3. Verification of Rejections

1. **Tampered Payload / Wrong Secret:**
   Sending an altered payload or wrong signature returns `401 Unauthorized`:
   ```json
   {"error":"invalid_signature","message":"Signature header X-SCI-Signature is missing or invalid"}
   ```

2. **Privacy Breach Rejection:**
   If a payload mistakenly contains any beneficiary identifier (e.g. `"beneficiaryRef": "..."`), the bot immediately refuses to process it with `400 Bad Request`:
   ```json
   {"error":"payload_rejected","message":"Privacy violation: payload contains beneficiary references"}
   ```
