import { streamConnections } from './metrics.js';

/**
 * In-process hand-off between the indexer and the live read API.
 *
 * The indexer commits a batch of events and then publishes what it committed;
 * `GET /stream` subscribes here and forwards each signal to the clients
 * watching that voucher or clinic. It is deliberately a plain in-process bus
 * rather than a queue: there is no delivery guarantee, no replay and no
 * subscriber state, so a stream that was not connected when the ledger closed
 * simply misses that update and the client catches up from the JSON routes.
 * Adding a broker would cost an operator and change nothing the client can
 * rely on, because the chain stays the source of truth.
 *
 * Two consequences worth stating plainly:
 *
 * - Only a process that runs the indexer has anything to publish, so the
 *   stream is live in combined mode (`npm start`) and in the API when it also
 *   indexes. A split deployment (`start:api` beside `start:indexer`) serves
 *   heartbeats on the stream but never data, because the two processes do not
 *   share memory. Same for several API replicas: each only sees its own.
 * - Publishing is best effort and must never fail a cycle. A client whose
 *   socket died mid-write is its own problem, not the indexer's.
 */

/**
 * One committed voucher state change, as the stream reports it.
 *
 * Only fields the chain already publishes, and specifically no beneficiary
 * reference: `voucher_created` and `receipt_minted` both carry one, and it is
 * an HMAC of a patient identifier. A live feed of care events must not become
 * the one place that leaks it.
 */
export type VoucherSignal = {
  /** Contract event name, e.g. `voucher_settled`. */
  type: string;
  voucherId: string;
  providerAddress: string;
  /** Status the event leaves the voucher in, one of `VOUCHER_STATUS`. */
  status: string;
  ledger: number;
  txHash: string;
  /** When the ledger closed, ISO 8601. */
  at: string;
};

type Listener = (signal: VoucherSignal) => void;

/** One entry per open `GET /stream` connection in this process. */
const listeners = new Set<Listener>();

/** Open streams, counted process-wide because each one holds a socket. */
let openStreams = 0;

/**
 * Takes one of the available stream slots.
 *
 * Returns false when the process is already at `max`, which is the only
 * thing stopping a page that reconnects on every blur from holding every
 * socket in the instance.
 */
export function acquireStreamSlot(max: number): boolean {
  if (openStreams >= max) return false;
  openStreams += 1;
  streamConnections.set(openStreams);
  return true;
}

/** Hands back a slot taken by `acquireStreamSlot`. Safe to call once per stream. */
export function releaseStreamSlot(): void {
  if (openStreams === 0) return;
  openStreams -= 1;
  streamConnections.set(openStreams);
}

/** Streams currently open in this process. */
export function openStreamCount(): number {
  return openStreams;
}

/** Whether anyone in this process would receive a published signal. */
export function hasStreamListeners(): boolean {
  return listeners.size > 0;
}

/**
 * Registers a listener and returns its unsubscribe.
 *
 * The unsubscribe is idempotent, because a stream is torn down by whichever
 * happens first: the client hanging up, the response erroring, or the app
 * closing during a deploy or a test teardown.
 */
export function subscribeVoucherSignals(listener: Listener): () => void {
  listeners.add(listener);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    listeners.delete(listener);
  };
}

/**
 * Fans committed signals out to the listeners.
 *
 * Returns the number of listeners it handed work to, which is 0 in the
 * common case of a process with no streams open. A listener that throws —
 * typically a socket that died between the write and the flush — is dropped
 * silently rather than being allowed to abort the loop for the others.
 */
export function publishVoucherSignals(signals: readonly VoucherSignal[]): number {
  if (signals.length === 0 || listeners.size === 0) return 0;
  for (const listener of listeners) {
    for (const signal of signals) {
      try {
        listener(signal);
      } catch {
        // A dead connection is cleaned up by its own close handler; the
        // indexer has already committed and owes it nothing.
      }
    }
  }
  return listeners.size;
}
