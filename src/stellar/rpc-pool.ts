import { rpc } from '@stellar/stellar-sdk';

import { redactRpcUrl } from '../env.js';

/**
 * Failover across several Soroban RPC endpoints.
 *
 * Public RPC endpoints have outages, and a backend pinned to one of them
 * stops indexing for the duration. The pool keeps one endpoint active,
 * counts consecutive failures against it, and rotates to the next once the
 * streak reaches `maxFailures` — then retries the same call there, so a
 * caller sees an outage as a slow request rather than an error.
 *
 * It deliberately does not probe endpoints in the background or race them
 * in parallel: that doubles the load on a public endpoint that may already
 * be struggling, which is exactly what the indexer's backoff is there to
 * avoid.
 */

/** The two log levels the pool uses; a pino or Fastify logger satisfies it. */
export type PoolLogger = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

const SILENT: PoolLogger = { info: () => {}, warn: () => {} };

export type RpcPoolOptions = {
  /** Consecutive failures against one endpoint before rotating. */
  maxFailures?: number;
  log?: PoolLogger;
  /** Overridable for tests, which pass fakes rather than real servers. */
  factory?: (url: string) => rpc.Server;
};

export function createServer(url: string): rpc.Server {
  return new rpc.Server(url, { allowHttp: url.startsWith('http://') });
}

export class RpcPool {
  private readonly servers: rpc.Server[];
  private readonly maxFailures: number;
  private readonly log: PoolLogger;
  private index = 0;
  /** Consecutive failures against the currently active endpoint. */
  private failures = 0;

  constructor(
    private readonly urls: readonly string[],
    { maxFailures = 3, log = SILENT, factory = createServer }: RpcPoolOptions = {},
  ) {
    if (urls.length === 0) throw new Error('RpcPool needs at least one RPC URL');
    this.servers = urls.map(factory);
    this.maxFailures = maxFailures;
    this.log = log;
  }

  /** The endpoint currently serving requests, with any credentials hidden. */
  get activeUrl(): string {
    return redactRpcUrl(this.urls[this.index]!);
  }

  /** Every configured endpoint, redacted, in failover order. */
  get allUrls(): string[] {
    return this.urls.map(redactRpcUrl);
  }

  /** Consecutive failures against the active endpoint. Exposed for tests. */
  get failureStreak(): number {
    return this.failures;
  }

  /**
   * Runs one RPC call against the active endpoint, rotating and retrying
   * when that endpoint has failed `maxFailures` times in a row.
   *
   * At most one attempt per configured endpoint: with every endpoint down,
   * the call fails rather than looping.
   */
  async run<T>(op: (server: rpc.Server) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await op(this.servers[this.index]!);
        if (this.failures > 0) {
          this.log.info(
            { url: this.activeUrl, afterFailures: this.failures },
            'soroban rpc endpoint recovered',
          );
          this.failures = 0;
        }
        return result;
      } catch (err) {
        this.failures += 1;
        const canRotate = this.servers.length > 1 && this.failures >= this.maxFailures;
        if (!canRotate || attempt >= this.servers.length) throw err;
        this.rotate(err);
      }
    }
  }

  /**
   * Moves to the next endpoint. The failure counter restarts so the new
   * endpoint gets its own full streak before it is given up on too.
   */
  private rotate(err: unknown): void {
    const from = this.activeUrl;
    const failures = this.failures;
    this.index = (this.index + 1) % this.servers.length;
    this.failures = 0;
    this.log.warn(
      { err, from, active: this.activeUrl, failures },
      'soroban rpc endpoint failing; switching to the next one',
    );
  }
}

/**
 * An `rpc.Server`-shaped facade over the pool.
 *
 * Only the methods this backend actually calls are forwarded. Keeping the
 * surface explicit means a new RPC call has to opt into failover rather
 * than silently bypassing it.
 */
export class FailoverRpcServer {
  constructor(private readonly pool: RpcPool) {}

  get activeUrl(): string {
    return this.pool.activeUrl;
  }

  get allUrls(): string[] {
    return this.pool.allUrls;
  }

  getHealth(
    ...args: Parameters<rpc.Server['getHealth']>
  ): ReturnType<rpc.Server['getHealth']> {
    return this.pool.run((s) => s.getHealth(...args));
  }

  getLatestLedger(
    ...args: Parameters<rpc.Server['getLatestLedger']>
  ): ReturnType<rpc.Server['getLatestLedger']> {
    return this.pool.run((s) => s.getLatestLedger(...args));
  }

  getEvents(
    ...args: Parameters<rpc.Server['getEvents']>
  ): ReturnType<rpc.Server['getEvents']> {
    return this.pool.run((s) => s.getEvents(...args));
  }

  simulateTransaction(
    ...args: Parameters<rpc.Server['simulateTransaction']>
  ): ReturnType<rpc.Server['simulateTransaction']> {
    return this.pool.run((s) => s.simulateTransaction(...args));
  }
}
