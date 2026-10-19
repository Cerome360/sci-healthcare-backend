import { createHmac, randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '../db.js';
import { env, WEBHOOK_URLS, WEBHOOKS_ENABLED } from '../env.js';

/**
 * Signed webhook notifications for voucher events.
 *
 * The API is read-only and has no accounts, so endpoints are configured by
 * the operator (`WEBHOOK_URLS`) rather than self-registered. Each delivery is
 * signed with HMAC-SHA256 under `WEBHOOK_SECRET` over the exact request body,
 * which lets a receiver prove the payload came from this service.
 *
 * Delivery is decoupled from indexing through the `WebhookDelivery` outbox:
 * a clinic with a slow or unreachable endpoint must never stall the cursor.
 */

/** Header carrying the hex HMAC-SHA256 of the raw request body. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-sci-signature';

/** Give up after this many failed attempts. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
/** First retry delay; doubles per attempt. */
export const WEBHOOK_BASE_BACKOFF_MS = 5_000;
/** Ceiling on the retry delay. */
export const WEBHOOK_MAX_BACKOFF_MS = 10 * 60_000;
/** How often the delivery loop looks for due rows. */
export const WEBHOOK_DELIVERY_INTERVAL_MS = 5_000;

/**
 * The event a receiver is told about. There is deliberately no beneficiary
 * reference here: the payload must not carry anything that could identify a
 * patient, even though the reference is itself opaque.
 */
export type VoucherWebhookEvent = {
  /** Contract event name, e.g. `voucher_settled`. */
  event: string;
  voucherId: string;
  /** Resulting voucher status, e.g. `Settled`. */
  status: string;
  txHash?: string | null;
  ledger: number;
};

/** The exact object that is serialised, signed and posted. */
export function webhookPayload(event: VoucherWebhookEvent): Record<string, unknown> {
  return {
    event: event.event,
    voucherId: event.voucherId,
    status: event.status,
    // Omitted, not null, when the RPC did not report a hash.
    ...(event.txHash ? { txHash: event.txHash } : {}),
    ledger: event.ledger,
  };
}

/** Hex HMAC-SHA256 of `body` under `secret`. */
export function signWebhook(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Queues one delivery per configured endpoint, inside `tx`.
 *
 * Running inside the caller's transaction is the whole point: if the
 * projection that produced the event rolls back, so does the notification.
 * A receiver can therefore trust that everything it is told about is in the
 * read model.
 */
export async function enqueueWebhook(
  tx: Prisma.TransactionClient,
  event: VoucherWebhookEvent,
): Promise<void> {
  if (!WEBHOOKS_ENABLED) return;
  const payload = JSON.stringify(webhookPayload(event));
  await tx.webhookDelivery.createMany({
    data: WEBHOOK_URLS.map((url) => ({
      id: randomUUID(),
      url,
      event: event.event,
      voucherId: event.voucherId,
      status: event.status,
      txHash: event.txHash ?? null,
      ledger: event.ledger,
      payload,
      nextAttemptAt: new Date(),
    })),
  });
}

/** Exponential backoff in milliseconds for the given attempt count. */
export function backoffMs(attempt: number, base = WEBHOOK_BASE_BACKOFF_MS, max = WEBHOOK_MAX_BACKOFF_MS): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(base * 2 ** exponent, max);
}

type OutboxRow = {
  id: string;
  url: string;
  event: string;
  voucherId: string;
  payload: string;
  attempts: number;
};

export type WebhookDispatcherOptions = {
  /** Overridable for tests; defaults to the configured `WEBHOOK_URLS`. */
  urls?: readonly string[];
  /** Overridable for tests; defaults to `WEBHOOK_SECRET`. */
  secret?: string;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  batchSize?: number;
  now?: () => Date;
};

/**
 * Delivers outbox rows on its own loop.
 *
 * This is intentionally separate from the indexer: a hundred failed
 * deliveries must not slow a single ledger, and a backed-off endpoint must
 * not hold the cursor.
 */
export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private delivering = false;

  private readonly urls: readonly string[];
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly log: FastifyBaseLogger,
    opts: WebhookDispatcherOptions = {},
  ) {
    this.urls = opts.urls ?? WEBHOOK_URLS;
    this.secret = opts.secret ?? env.WEBHOOK_SECRET;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.intervalMs = opts.intervalMs ?? WEBHOOK_DELIVERY_INTERVAL_MS;
    this.maxAttempts = opts.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
    this.baseBackoffMs = opts.baseBackoffMs ?? WEBHOOK_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? WEBHOOK_MAX_BACKOFF_MS;
    this.batchSize = opts.batchSize ?? 50;
    this.now = opts.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.urls.length > 0 && this.secret.length > 0;
  }

  start(): void {
    if (!this.enabled) {
      this.log.info('webhooks disabled; no endpoints configured');
      return;
    }
    this.log.info({ endpoints: this.urls.length }, 'webhook delivery started');
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.cycle();
    }, this.intervalMs);
    // The API server or the indexer loop is what keeps the process alive;
    // the delivery loop must never be the only reason it cannot exit.
    this.timer.unref();
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.deliverPending();
    } catch (err) {
      this.log.error({ err }, 'webhook delivery cycle failed');
    } finally {
      this.schedule();
    }
  }

  /**
   * Attempts every delivery whose backoff has elapsed. Returns how many were
   * delivered, which is what tests assert on.
   */
  async deliverPending(): Promise<number> {
    if (this.delivering) return 0;
    this.delivering = true;
    try {
      const due = await prisma.webhookDelivery.findMany({
        where: {
          deliveredAt: null,
          abandonedAt: null,
          nextAttemptAt: { lte: this.now() },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: this.batchSize,
      });

      let delivered = 0;
      for (const row of due) {
        if (await this.attempt(row)) delivered += 1;
      }
      return delivered;
    } finally {
      this.delivering = false;
    }
  }

  private async attempt(row: OutboxRow): Promise<boolean> {
    const attempts = row.attempts + 1;
    let error: string | null = null;
    let retryable = true;

    try {
      const res = await this.fetchImpl(row.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [WEBHOOK_SIGNATURE_HEADER]: signWebhook(row.payload, this.secret),
        },
        body: row.payload,
      });

      if (res.ok) {
        await prisma.webhookDelivery.update({
          where: { id: row.id },
          data: { attempts, deliveredAt: this.now(), lastError: null },
        });
        this.log.info(
          { id: row.id, url: row.url, event: row.event, voucherId: row.voucherId },
          'webhook delivered',
        );
        return true;
      }

      error = `HTTP ${res.status}`;
      // 4xx other than 408/429 will not get better by retrying.
      retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    } catch (err) {
      error = (err as Error).message;
      retryable = true;
    }

    const abandoned = !retryable || attempts >= this.maxAttempts;
    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: {
        attempts,
        lastError: error,
        ...(abandoned
          ? { abandonedAt: this.now() }
          : {
              nextAttemptAt: new Date(
                this.now().getTime() + backoffMs(attempts, this.baseBackoffMs, this.maxBackoffMs),
              ),
            }),
      },
    });

    this.log.warn(
      { id: row.id, url: row.url, attempts, error, abandoned },
      'webhook delivery failed',
    );
    return false;
  }
}
