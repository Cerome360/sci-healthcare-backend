import type { ServerResponse } from 'node:http';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { env } from '../env.js';
import {
  acquireStreamSlot,
  releaseStreamSlot,
  subscribeVoucherSignals,
} from '../lib/event-bus.js';
import { ApiError } from '../lib/errors.js';

/**
 * Live voucher updates over server-sent events (#50).
 *
 * The read model is a projection of the chain, so the thing a page cannot
 * know on its own is *when* it changed. Before this route the only answer was
 * to poll or reload, which is why a transaction could look like it had made
 * no difference. Here the indexer tells this process what it just committed
 * and the route forwards it, so a wallet view updates on the ledger that
 * settled the voucher.
 *
 * What a client is told is exactly what the JSON routes already expose for
 * the same transition: voucher id, new status, clinic address, ledger, tx
 * hash and the ledger close time. There is deliberately **no beneficiary
 * reference**, even though `voucher_created` carries one on chain — the
 * reference is an HMAC of a patient identifier, and a long-lived push channel
 * is the last place it should appear. Nothing is read from the database to
 * answer a stream request, so the stream cannot become a second way to walk
 * the read model: it only ever reports events that just happened.
 */
const streamQuery = z
  .object({
    voucher: z.string().min(1).max(64).optional(),
    provider: z.string().length(56).optional(),
  })
  .refine((data) => Boolean(data.voucher) !== Boolean(data.provider), {
    message: 'Provide exactly one of: voucher, provider',
    path: ['voucher', 'provider'],
  });

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  /** The responses this scope is holding open, so closing can release them. */
  const open = new Set<ServerResponse>();

  // A stream never ends by itself, and a response that is still open keeps its
  // socket busy, so `server.close()` — which only waits for idle connections —
  // would never return. `preClose` is the application hook that Fastify runs
  // *before* it touches the server; `onClose` is too late, because the root's
  // own close hook (the one that closes the server) is registered after the
  // plugins and therefore runs first, and the wait happens inside it.
  // Without this, a SIGTERM during a deploy — or the end of a test — would sit
  // on a perfectly healthy idle stream until the shutdown timer fired.
  app.addHook('preClose', () => {
    for (const res of open) {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
    open.clear();
  });

  /**
   * Subscribes to voucher updates for one voucher or one clinic.
   *
   * A filter is required, like every other route that carries patient
   * context: an unfiltered firehose of care-state transitions would turn a
   * read-only API into a way to watch a clinic's patient volume in real time.
   * `?provider=` is still only the public half of that — the clinic, the
   * voucher id and the status — and it is what a clinic's own dashboard needs.
   */
  app.get(
    '/stream',
    {
      schema: {
        tags: ['stream'],
        summary: 'Live voucher updates (server-sent events)',
        description:
          'Streams voucher state transitions as the indexer commits them. ' +
          'Requires exactly one of `voucher` or `provider`. Each `data:` frame ' +
          'is one JSON object with `type`, `voucherId`, `providerAddress`, ' +
          '`status`, `ledger`, `txHash` and `at`; it never contains a ' +
          'beneficiary reference. Comment lines are heartbeats.',
      },
    },
    async (req, reply) => {
      const parsed = streamQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const { voucher, provider } = parsed.data;

      // Checked before hijacking: past this point Fastify no longer owns the
      // response, so an error would have to be framed by hand.
      if (!acquireStreamSlot(env.SSE_MAX_CONNECTIONS)) {
        throw new ApiError(
          503,
          'stream_full',
          `This instance is holding its ${env.SSE_MAX_CONNECTIONS} open streams; try again shortly`,
        );
      }

      // The reply leaves the request lifecycle: a stream has no body to
      // return, and the app-level `onSend` hook (cache headers, ETag, error
      // envelope) and the compressor both assume a response that finishes.
      reply.hijack();
      const res = reply.raw;
      open.add(res);

      // Hijacking also skips the legacy scope's `onSend` hook, so the
      // unversioned alias has to mark itself as deprecated here like every
      // other response on it does. Control characters are stripped before the
      // URL is echoed into a header, as in `app.ts`.
      const aliasHeaders: Record<string, string> = {};
      if (!req.url.startsWith('/v1/')) {
        const target = req.url.replace(/[\r\n]/g, '');
        aliasHeaders['deprecation'] = 'true';
        aliasHeaders['link'] = `</v1${target}>; rel="successor-version"`;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store, must-revalidate',
        connection: 'keep-alive',
        // A proxy that buffers would hold every frame until it filled a page.
        'x-accel-buffering': 'no',
        // Normally added by the app-level hook that this response bypasses; a
        // stream needs its id for support just as much as any other request.
        'x-request-id': req.id,
        'x-stellar-network': env.STELLAR_NETWORK,
        ...aliasHeaders,
      });

      let heartbeat: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;
      let released = false;

      /** Detaches from the bus and gives the slot back, at most once. */
      const cleanup = (): void => {
        if (released) return;
        released = true;
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
        open.delete(res);
        releaseStreamSlot();
      };

      /** Ends the response, then cleans up. Called on every teardown path. */
      const drop = (): void => {
        if (!res.writableEnded && !res.destroyed) res.end();
        cleanup();
      };

      const write = (frame: string): void => {
        try {
          // `false` means the client is not draining what it was already
          // given. For a live feed the newest state is the only useful one, so
          // a client that cannot keep up is disconnected — and it will
          // reconnect and read the current state from the JSON routes — rather
          // than allowed to pin an unbounded write buffer in this process.
          if (!res.write(frame)) drop();
        } catch {
          // A socket that died between the write and the flush. Its handler
          // below releases everything; the indexer is owed nothing.
          drop();
        }
      };

      // Any of these can be the first to fire, depending on how the
      // connection died, and `drop` is idempotent.
      req.raw.on('close', drop);
      res.on('close', drop);
      res.on('error', drop);

      // Flushed immediately: those bytes are what move a client from
      // "connecting" to "open", and they prove the headers got through.
      write(': connected\n\n');

      unsubscribe = subscribeVoucherSignals((signal) => {
        const wanted = voucher ? signal.voucherId === voucher : signal.providerAddress === provider;
        if (!wanted) return;
        // `JSON.stringify` escapes newlines and control characters, so no
        // value coming off the chain can close this frame and start another.
        write(`data: ${JSON.stringify(signal)}\n\n`);
      });

      heartbeat = setInterval(() => write(': heartbeat\n\n'), env.SSE_HEARTBEAT_MS);
      // An idle stream must not be a reason for the process to stay alive:
      // tests and shutdown would wait on a socket nobody is watching.
      heartbeat.unref();
    },
  );
}
