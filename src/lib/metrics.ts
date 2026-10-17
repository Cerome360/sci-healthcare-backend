import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics, exposed at `/metrics`.
 *
 * Indexer figures are updated by the indexer, so they are populated in the
 * process that runs it (combined mode, or the worker). A split API process
 * serves the HTTP and process metrics only.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/** Wall-clock ms of the last poll that completed, or null before the first. */
let lastSuccessAt: number | null = null;

export function markIndexerSuccess(now: number = Date.now()): void {
  lastSuccessAt = now;
}

export const indexerLagLedgers = new Gauge({
  name: 'indexer_lag_ledgers',
  help: 'Ledgers between the chain tip and the indexer cursor after the last poll',
  registers: [registry],
});

export const indexerSecondsSinceSuccess = new Gauge({
  name: 'indexer_seconds_since_success',
  help: 'Seconds since the last poll that completed without error',
  registers: [registry],
  collect() {
    if (lastSuccessAt !== null) this.set((Date.now() - lastSuccessAt) / 1000);
  },
});

export const eventsApplied = new Counter({
  name: 'events_applied_total',
  help: 'Contract events projected into the read model',
  labelNames: ['name'],
  registers: [registry],
});

export const eventsSkipped = new Counter({
  name: 'events_skipped_total',
  help: 'Contract events that failed to project and were recorded as failed',
  labelNames: ['name'],
  registers: [registry],
});

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests handled',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/**
 * Open `GET /stream` connections in this process.
 *
 * A stream is held open rather than served and returned, so it costs a socket
 * for as long as the client is watching. This is the series that shows the
 * instance approaching `SSE_MAX_CONNECTIONS`, at which point new viewers get
 * a 503 instead of a queue.
 */
export const streamConnections = new Gauge({
  name: 'stream_connections',
  help: 'Server-sent event streams currently open in this process',
  registers: [registry],
});
