import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { server } from '../stellar/client.js';
import { Indexer } from '../stellar/indexer.js';
import { collectEvents } from '../stellar/paging.js';
import {
  isTracingEnabled,
  startTracingIfConfigured,
  withSpan,
} from '../tracing.js';

/**
 * OpenTelemetry tracing (#54).
 *
 * Two halves, matching the two acceptance criteria that can be proven
 * without a collector:
 *
 * 1. the SDK starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and
 *    `@opentelemetry/sdk-node` is mocked so no test ever opens an exporter
 *    or registers a global provider behind our back;
 * 2. the manual spans — indexer cycle, RPC calls, the projection
 *    transaction — really appear on an in-memory tracer while a normal
 *    `Indexer.tick()` runs against the throwaway database.
 */

vi.mock('../stellar/paging.js', () => ({
  collectEvents: vi.fn(),
}));

// Hoisted so the vi.mock factory below may reference it.
const sdkCalls = vi.hoisted(() => ({
  constructed: 0,
  started: 0,
  options: [] as { instrumentations?: { instrumentationName: string }[] }[],
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(options: { instrumentations?: { instrumentationName: string }[] }) {
      sdkCalls.constructed += 1;
      sdkCalls.options.push(options);
    }
    start(): void {
      sdkCalls.started += 1;
    }
    async shutdown(): Promise<void> {}
  },
}));

function fakeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

describe('tracing is env-gated (#54)', () => {
  // Order matters: startTracingIfConfigured caches the SDK it starts, so the
  // "off" case has to be observed before the "on" case runs.

  it('isTracingEnabled is false when the endpoint is unset or blank', () => {
    expect(isTracingEnabled({})).toBe(false);
    expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toBe(false);
    expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBe(false);
  });

  it('isTracingEnabled is true when the endpoint is set', () => {
    expect(isTracingEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' })).toBe(true);
  });

  it('starts nothing without the endpoint variable', () => {
    expect(startTracingIfConfigured({})).toBeNull();
    expect(sdkCalls.constructed).toBe(0);
    expect(sdkCalls.started).toBe(0);
  });

  it('constructs and starts the SDK with HTTP, Fastify and Prisma instrumentation when it is set', () => {
    const sdk = startTracingIfConfigured({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    });
    expect(sdk).not.toBeNull();
    expect(sdkCalls.constructed).toBe(1);
    expect(sdkCalls.started).toBe(1);
    expect(sdkCalls.options[0]?.instrumentations?.map((i) => i.instrumentationName).sort()).toEqual(
      [
        '@opentelemetry/instrumentation-fastify',
        '@opentelemetry/instrumentation-http',
        '@prisma/instrumentation',
      ],
    );
  });

  it('does not start a second SDK when called again', () => {
    startTracingIfConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' });
    expect(sdkCalls.constructed).toBe(1);
    expect(sdkCalls.started).toBe(1);
  });
});

describe('withSpan', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    // Nothing else in this file needs a tracer, and the API refuses a second
    // global provider anyway; the exporter stays in memory for the process.
  });

  beforeEach(() => {
    exporter.reset();
  });

  it('records a span with attributes and returns the value', async () => {
    const value = await withSpan('test.operation', async (span) => {
      span.setAttribute('answer', 42);
      return 'done';
    });
    expect(value).toBe('done');
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(['test.operation']);
    expect(spans[0]?.attributes['answer']).toBe(42);
  });

  it('records the error on the span and rethrows', async () => {
    await expect(
      withSpan('test.failing', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const span = exporter.getFinishedSpans()[0];
    expect(span?.name).toBe('test.failing');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('nesting child spans under an active parent span', async () => {
    await withSpan('test.parent', async () => {
      await withSpan('test.child', async () => undefined);
    });
    const spans = exporter.getFinishedSpans();
    const parent = spans.find((s) => s.name === 'test.parent');
    const child = spans.find((s) => s.name === 'test.child');
    expect(parent).toBeDefined();
    // OTel SDK 2.x exposes the parent as `parentSpanContext`.
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
  });

  it('produces real spans for one indexer cycle: cycle, RPC calls and the projection transaction', async () => {
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: 100 },
      update: { lastLedger: 100, leaseOwner: null, leaseExpiresAt: null, gap: false, gapOldestLedger: null, gapCursorLedger: null },
    });
    vi.spyOn(server, 'getHealth').mockResolvedValue({
      oldestLedger: 1,
      latestLedger: 1000,
    } as never);
    vi.mocked(collectEvents).mockResolvedValue({
      events: [],
      throughLedger: 101,
      hasMore: false,
    } as never);

    const indexer = new Indexer(fakeLog(), {
      lease: {
        acquire: async () => true,
        refresh: async () => true,
        release: async () => {},
        owner: 'test',
        ttlMs: 1,
      } as never,
    });
    // tick() runs one poll: no lease scheduling, no timers to clean up.
    const applied = await indexer.tick();
    expect(applied).toBe(0);

    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toContain('indexer.cycle');
    expect(names).toContain('rpc.getHealth');
    expect(names).toContain('rpc.getContractEvents');
    expect(names).toContain('db.transaction');

    const cycle = exporter.getFinishedSpans().find((s) => s.name === 'indexer.cycle');
    expect(cycle?.attributes['indexer.events_applied']).toBe(0);
    const tx = exporter.getFinishedSpans().find((s) => s.name === 'db.transaction');
    expect(tx?.attributes['indexer.ledger.through']).toBe(101);

    await indexer.stop();
    exporter.reset();
    vi.restoreAllMocks();
  });
});
