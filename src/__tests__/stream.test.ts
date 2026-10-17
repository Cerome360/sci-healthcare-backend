import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { type IncomingHttpHeaders, request } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #50 — the live voucher stream, driven through a real HTTP client.
 *
 * `app.inject()` cannot be used here: it resolves when the response is
 * finished, and a stream is defined by not finishing. So this file is the one
 * place that listens on a socket, which is also what makes the frames, the
 * cap and the heartbeat observable rather than theoretical.
 *
 * The two environment values below are set before the app is imported on
 * purpose: `src/env.ts` reads the environment once, at module load. A small
 * cap and a short heartbeat are what let a test finish in seconds instead of
 * waiting on production timings nobody exercises.
 */
process.env.SSE_MAX_CONNECTIONS = '2';
process.env.SSE_HEARTBEAT_MS = '250';

const { buildApp } = await import('../app.js');
const { prisma } = await import('../db.js');
const { env } = await import('../env.js');
const { openStreamCount } = await import('../lib/event-bus.js');
const { server } = await import('../stellar/client.js');
const { Indexer } = await import('../stellar/indexer.js');
const { collectEvents } = await import('../stellar/paging.js');

vi.mock('../stellar/paging.js', () => ({
  collectEvents: vi.fn(),
}));

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const ATTESTER = 'GBWBYKGC5OCRELVP5WHAKEMBSZMNUY3HOKVSYBQGLFNWWQHNH2SD53FZ';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const TX_HASH = 'b'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

/** Frame timings: long enough for bytes to cross the socket, short in total. */
const SETTLE_MS = 150;

let app: Awaited<ReturnType<typeof buildApp>>;
let port = 0;
/** Every stream this file opened, so one leak cannot poison the next test. */
const live: { close: () => void }[] = [];

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function sym(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: 'symbol' });
}

/**
 * A raw contract event in the shape `decodeEvent` expects: the name and any
 * `#[topic]` fields in the topic list, the data fields in the value.
 */
function rawEvent(name: string, ledger: number, data: Record<string, unknown>, topics: xdr.ScVal[] = []) {
  return {
    id: `${name}-${ledger}`,
    contractId: env.VOUCHER_CONTRACT_ID,
    txHash: TX_HASH,
    ledger,
    ledgerClosedAt: '2026-10-01T00:00:00Z',
    topic: [sym(name), ...topics],
    value: nativeToScVal(data),
  };
}

function stubEvents(events: ReturnType<typeof rawEvent>[], throughLedger: number): void {
  vi.mocked(collectEvents).mockResolvedValue({
    events,
    throughLedger,
    hasMore: false,
  } as never);
}

type LiveStream = {
  status: number;
  headers: IncomingHttpHeaders;
  /** Everything received so far, as text. */
  body: string;
  ended: boolean;
  close: () => void;
};

/** Opens `GET /stream<path>` and resolves once the response headers arrive. */
function openStream(path: string, targetPort = port): Promise<LiveStream> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: targetPort, path, method: 'GET' }, (res) => {
      const stream: LiveStream = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: '',
        ended: false,
        close: () => req.destroy(),
      };
      live.push(stream);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        stream.body += chunk;
      });
      res.on('end', () => {
        stream.ended = true;
      });
      res.on('close', () => {
        stream.ended = true;
      });
      // A stream destroyed by `close()` errors by definition; the test that
      // did it is already done with this one.
      res.on('error', () => {});
      resolve(stream);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Waits for a non-stream response (a 400 or a 503) to finish, then parses it. */
async function readJson(stream: LiveStream): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(stream.ended).toBe(true), { timeout: 4_000, interval: 10 });
  return JSON.parse(stream.body) as Record<string, unknown>;
}

/** The `data:` payload frames of a stream, oldest first. */
function frames(stream: LiveStream): string[] {
  return stream.body
    .split('\n\n')
    .filter((part) => part.startsWith('data: '))
    .map((part) => part.slice('data: '.length));
}

async function seedVoucher(id: string): Promise<void> {
  await prisma.provider.upsert({
    where: { address: CLINIC },
    create: {
      address: CLINIC,
      name: 'Ikeja General Clinic',
      country: 'NG',
      status: 'Active',
      registeredAt: new Date('2026-09-01T00:00:00Z'),
    },
    update: {},
  });
  await prisma.voucher.create({
    data: {
      id,
      funder: FUNDER,
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      status: 'Funded',
      createdAt: new Date(Date.now() - DAY),
      expiresAt: new Date(Date.now() + DAY),
    },
  });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}, 30_000);

beforeEach(async () => {
  vi.mocked(collectEvents).mockReset();
  vi.spyOn(server, 'getHealth').mockResolvedValue({
    oldestLedger: 1,
    latestLedger: 1000,
  } as never);
  await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastLedger: 100 },
    update: { lastLedger: 100, leaseOwner: null, leaseExpiresAt: null },
  });
  await prisma.failedEvent.deleteMany();
  // In dependency order, like the other route tests: `Service` has a real
  // foreign key to `Provider`, so the clinic a leftover row from the previous
  // test file points at cannot be deleted out from under it.
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (live.length > 0) live.pop()?.close();
  // The cap is process-wide, so a slot the last test was still holding would
  // be a 503 in the next one. Wait for the server to notice each hang-up.
  await vi.waitFor(() => expect(openStreamCount()).toBe(0), { timeout: 4_000, interval: 10 });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('GET /stream', () => {
  it('requires exactly one of voucher or provider', async () => {
    const bare = await openStream('/v1/stream');
    expect(bare.status).toBe(400);
    expect(await readJson(bare)).toMatchObject({ error: 'invalid_query' });

    const both = await openStream(
      `/v1/stream?voucher=5001&provider=${CLINIC}`,
    );
    expect(both.status).toBe(400);
    expect(await readJson(both)).toMatchObject({ error: 'invalid_query' });

    const shortProvider = await openStream('/v1/stream?provider=too-short');
    expect(shortProvider.status).toBe(400);
    expect(await readJson(shortProvider)).toMatchObject({ error: 'invalid_query' });
  });

  it('answers with SSE framing and no caching, and carries the request id', async () => {
    const stream = await openStream('/v1/stream?voucher=5001');
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(stream.headers['cache-control']).toContain('no-store');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    expect(stream.headers['x-request-id']).toBeTruthy();
    expect(stream.headers['x-stellar-network']).toBe(env.STELLAR_NETWORK);
    // The canonical path is not the deprecated alias.
    expect(stream.headers['deprecation']).toBeUndefined();

    // Flushed immediately, so a client knows the connection is really open.
    await vi.waitFor(() => expect(stream.body).toContain(': connected'), {
      timeout: 4_000,
      interval: 10,
    });
  });

  it('serves the canonical /v1 path and the unversioned alias alike', async () => {
    await seedVoucher('5001');
    const legacy = await openStream('/stream?voucher=5001');
    expect(legacy.status).toBe(200);
    // A hijacked response bypasses the scope hook that marks the unversioned
    // aliases, so the stream has to carry it itself.
    expect(legacy.headers['deprecation']).toBe('true');
    expect(legacy.headers['link']).toBe('</v1/stream?voucher=5001>; rel="successor-version"');

    stubEvents(
      [
        rawEvent(
          'voucher_claimed',
          101,
          { voucher_id: 5001n, claimed_at: 1_760_000_000n },
          [Address.fromString(CLINIC).toScVal()],
        ),
      ],
      101,
    );
    await new Indexer(fakeLog()).tick();

    await vi.waitFor(() => expect(frames(legacy)).toHaveLength(1), { timeout: 4_000, interval: 10 });
    expect(JSON.parse(frames(legacy)[0]!)).toMatchObject({
      type: 'voucher_claimed',
      voucherId: '5001',
      status: 'Claimed',
      providerAddress: CLINIC,
    });
  });

  it('delivers a committed settlement to the voucher it belongs to', async () => {
    await seedVoucher('5001');
    const watching = await openStream('/v1/stream?voucher=5001');
    const other = await openStream(`/v1/stream?provider=${ATTESTER}`);

    stubEvents(
      [
        rawEvent(
          'voucher_settled',
          101,
          { voucher_id: 5001n, net: 29_700_000n, fee: 300_000n },
          [Address.fromString(CLINIC).toScVal()],
        ),
      ],
      101,
    );
    const applied = await new Indexer(fakeLog()).tick();
    expect(applied).toBe(1);

    await vi.waitFor(() => expect(frames(watching)).toHaveLength(1), {
      timeout: 4_000,
      interval: 10,
    });
    const signal = JSON.parse(frames(watching)[0]!) as Record<string, unknown>;
    expect(signal).toEqual({
      type: 'voucher_settled',
      voucherId: '5001',
      providerAddress: CLINIC,
      status: 'Settled',
      ledger: 101,
      txHash: TX_HASH,
      at: '2026-10-01T00:00:00.000Z',
    });

    // The row is committed before the frame is sent, so the client is never
    // told about a state the API cannot yet serve.
    const stored = await prisma.voucher.findUnique({ where: { id: '5001' } });
    expect(stored?.status).toBe('Settled');

    // And a stream for someone else's clinic hears nothing at all.
    expect(frames(other)).toHaveLength(0);
  });

  it('never puts a beneficiary reference on the stream', async () => {
    const stream = await openStream('/v1/stream?voucher=5002');

    // `voucher_created` is the event that carries the reference, in its topic,
    // and the row the handler writes keeps it. The frame must not.
    stubEvents(
      [
        rawEvent(
          'voucher_created',
          101,
          {
            voucher_id: 5002n,
            created_at: 1_760_000_000n,
            expires_at: 1_770_000_000n,
            amount: 40_000_000n,
            service_code: 202n,
          },
          [
            Address.fromString(FUNDER).toScVal(),
            Address.fromString(CLINIC).toScVal(),
            nativeToScVal(Buffer.from(REF, 'hex'), { type: 'bytes' }),
          ],
        ),
      ],
      101,
    );
    await new Indexer(fakeLog()).tick();

    await vi.waitFor(() => expect(frames(stream)).toHaveLength(1), { timeout: 4_000, interval: 10 });
    expect(JSON.parse(frames(stream)[0]!)).toEqual({
      type: 'voucher_created',
      voucherId: '5002',
      providerAddress: CLINIC,
      status: 'Funded',
      ledger: 101,
      txHash: TX_HASH,
      at: '2026-10-01T00:00:00.000Z',
    });
    expect(stream.body).not.toContain(REF);
    expect(stream.body.toLowerCase()).not.toContain('beneficiary');

    // The projection kept the reference where it belongs: in the read model.
    expect(await prisma.voucher.findUnique({ where: { id: '5002' } })).toMatchObject({
      beneficiaryRef: REF,
    });
  });

  it('resolves the clinic for an event that only carries the funder', async () => {
    await seedVoucher('5001');
    const stream = await openStream(`/v1/stream?provider=${CLINIC}`);

    // `voucher_refunded` puts the funder in its topic and no provider, so the
    // clinic comes from the row the handler just committed.
    stubEvents(
      [
        rawEvent(
          'voucher_refunded',
          101,
          { voucher_id: 5001n },
          [Address.fromString(FUNDER).toScVal()],
        ),
      ],
      101,
    );
    await new Indexer(fakeLog()).tick();

    await vi.waitFor(() => expect(frames(stream)).toHaveLength(1), { timeout: 4_000, interval: 10 });
    expect(JSON.parse(frames(stream)[0]!)).toMatchObject({
      type: 'voucher_refunded',
      status: 'Refunded',
      providerAddress: CLINIC,
    });
  });

  it('publishes nothing for a voucher that is not in the read model', async () => {
    const stream = await openStream('/v1/stream?voucher=8888');

    // Valid payload, so the handler runs — it just matches no row, because
    // this indexer never saw the voucher being created.
    stubEvents(
      [
        rawEvent(
          'voucher_attested',
          101,
          { voucher_id: 8888n, attested_at: 1_760_000_000n, dispute_deadline: 1_760_600_000n },
          [Address.fromString(ATTESTER).toScVal()],
        ),
      ],
      101,
    );
    await new Indexer(fakeLog()).tick();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    expect(frames(stream)).toHaveLength(0);
  });

  it('publishes nothing when the event fails to project and rolls back', async () => {
    await seedVoucher('5001');
    const stream = await openStream('/v1/stream?voucher=5001');

    // `voucher_settled` without its amounts: `asAmount` throws on the missing
    // `net`, the savepoint rolls the whole event back and it is dead-lettered.
    // A client must never see the half of it that was discarded.
    stubEvents(
      [
        rawEvent(
          'voucher_settled',
          101,
          { voucher_id: 5001n },
          [Address.fromString(CLINIC).toScVal()],
        ),
      ],
      101,
    );
    await new Indexer(fakeLog()).tick();

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(frames(stream)).toHaveLength(0);
    expect(await prisma.voucher.findUnique({ where: { id: '5001' } })).toMatchObject({
      status: 'Funded',
    });
    expect(await prisma.failedEvent.count({ where: { id: 'voucher_settled-101' } })).toBe(1);
  });

  it('never lets the stream change what the indexer commits', async () => {
    await seedVoucher('5001');
    const stream = await openStream('/v1/stream?voucher=5001');

    // The provider topic decoded to something that is not an address. The
    // settlement handler never reads that field, so before the stream existed
    // this event applied normally — building the signal must not be what turns
    // it into a dead letter. It falls back to the clinic on the row instead.
    stubEvents(
      [
        rawEvent(
          'voucher_settled',
          101,
          { voucher_id: 5001n, net: 29_700_000n, fee: 300_000n },
          [nativeToScVal('not-an-address', { type: 'string' })],
        ),
      ],
      101,
    );
    expect(await new Indexer(fakeLog()).tick()).toBe(1);
    expect(await prisma.failedEvent.count()).toBe(0);
    expect(await prisma.voucher.findUnique({ where: { id: '5001' } })).toMatchObject({
      status: 'Settled',
    });

    await vi.waitFor(() => expect(frames(stream)).toHaveLength(1), { timeout: 4_000, interval: 10 });
    expect(JSON.parse(frames(stream)[0]!)).toMatchObject({
      type: 'voucher_settled',
      status: 'Settled',
      providerAddress: CLINIC,
    });
  });

  it('keeps quiet when nobody is watching, and publishes to everyone who is', async () => {
    await seedVoucher('5001');
    expect(openStreamCount()).toBe(0);

    stubEvents(
      [
        rawEvent(
          'voucher_settled',
          101,
          { voucher_id: 5001n, net: 1n, fee: 1n },
          [Address.fromString(CLINIC).toScVal()],
        ),
      ],
      101,
    );
    // No stream open: the cycle still commits, and publishes nothing.
    await new Indexer(fakeLog()).tick();
    expect(await prisma.voucher.findUnique({ where: { id: '5001' } })).toMatchObject({
      status: 'Settled',
    });

    const one = await openStream('/v1/stream?voucher=5001');
    const two = await openStream(`/v1/stream?provider=${CLINIC}`);
    expect(openStreamCount()).toBe(2);

    stubEvents(
      [
        rawEvent(
          'voucher_claimed',
          102,
          { voucher_id: 5001n, claimed_at: 1_760_000_000n },
          [Address.fromString(CLINIC).toScVal()],
        ),
      ],
      102,
    );
    await prisma.voucher.update({ where: { id: '5001' }, data: { status: 'Funded' } });
    await new Indexer(fakeLog()).tick();

    await vi.waitFor(() => expect(frames(one)).toHaveLength(1), { timeout: 4_000, interval: 10 });
    await vi.waitFor(() => expect(frames(two)).toHaveLength(1), { timeout: 4_000, interval: 10 });
  });

  it('beats a heartbeat while the stream is idle', async () => {
    const stream = await openStream('/v1/stream?voucher=5001');
    await vi.waitFor(() => expect(stream.body).toContain(': heartbeat'), {
      timeout: 4_000,
      interval: 20,
    });
    // Heartbeats are comments, so a client parsing frames is not woken by them.
    expect(frames(stream)).toHaveLength(0);
  });

  it('refuses more streams than the process is allowed to hold, and frees the slot again', async () => {
    const first = await openStream('/v1/stream?voucher=1');
    const second = await openStream('/v1/stream?voucher=2');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(openStreamCount()).toBe(2);

    const third = await openStream('/v1/stream?voucher=3');
    expect(third.status).toBe(503);
    expect(await readJson(third)).toMatchObject({ error: 'stream_full' });
    expect(third.headers['cache-control']).toBe('no-store');

    // Releasing one connection makes room, so the cap cannot be a slow leak.
    first.close();
    await vi.waitFor(() => expect(openStreamCount()).toBe(1), {
      timeout: 4_000,
      interval: 10,
    });
    const fourth = await openStream('/v1/stream?voucher=4');
    expect(fourth.status).toBe(200);
  });

  it('ends open streams when the app closes, instead of hanging shutdown', async () => {
    // A separate instance: this one is the thing under test, and combined mode
    // closes the app on every SIGTERM.
    const closing = await buildApp({ logger: false });
    await closing.listen({ port: 0, host: '127.0.0.1' });
    const closingPort = (closing.server.address() as AddressInfo).port;

    const held = await openStream('/v1/stream?voucher=7', closingPort);
    await vi.waitFor(() => expect(held.body).toContain(': connected'), {
      timeout: 4_000,
      interval: 10,
    });
    expect(openStreamCount()).toBe(1);

    // Without the `preClose` release this never resolves: the server would
    // wait for a connection that is still busy answering a request, and the
    // only thing that would ever end the stream is the shutdown timer.
    await closing.close();

    await vi.waitFor(() => expect(held.ended).toBe(true), { timeout: 4_000, interval: 10 });
    await vi.waitFor(() => expect(openStreamCount()).toBe(0), { timeout: 4_000, interval: 10 });
  });
});
