import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PrismaInstrumentation } from '@prisma/instrumentation';

import { APP_VERSION } from './lib/version.js';

/**
 * OpenTelemetry tracing (#54).
 *
 * The one question this exists to answer is where the time in a slow request
 * or indexer cycle goes: the Soroban RPC, the database, or our own code.
 *
 * The rule is stated in the issue and it is the rule here: the SDK starts
 * only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and stays off otherwise.
 * With it unset nothing is started, nothing is exported and every tracer
 * handed out below is the no-op implementation from `@opentelemetry/api` —
 * `withSpan` then costs one function call and nothing else. Tests never see
 * a span unless they install a tracer provider themselves.
 *
 * Which collector to talk to, with what authentication, is entirely the
 * standard OTLP environment contract (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`); this module reads
 * those and nothing app-specific, so any OTLP-speaking backend works and
 * the app stays exporter-agnostic.
 */

/** The variable that turns tracing on. Unset or blank means off. */
export const TRACING_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/** True when the environment asks for tracing. */
export function isTracingEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  const endpoint = source[TRACING_ENDPOINT_ENV];
  return typeof endpoint === 'string' && endpoint.trim().length > 0;
}

let sdk: NodeSDK | null = null;

/**
 * Starts the Node SDK once, when configured; returns `null` when not.
 *
 * HTTP routes, the Fastify request handlers and Prisma queries get their
 * spans from the three instrumentations; indexer-cycle and RPC-call spans
 * are the manual ones in `src/stellar/indexer.ts`. Calling it twice is
 * harmless — the SDK starts once and later calls return the same instance.
 */
export function startTracingIfConfigured(
  source: NodeJS.ProcessEnv = process.env,
): NodeSDK | null {
  if (sdk !== null) return sdk;
  if (!isTracingEnabled(source)) return null;

  sdk = new NodeSDK({
    // The trace exporter is resolved by the SDK itself from the standard
    // OTEL_EXPORTER_OTLP_* variables, so no endpoint or credential appears
    // in this file.
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      new PrismaInstrumentation(),
    ],
  });
  sdk.start();
  return sdk;
}

/**
 * The tracer is resolved per call, not once at module load:
 * `@opentelemetry/api` hands out a no-op tracer while no provider is
 * registered, and a tracer captured at import time keeps that no-op delegate
 * even after `startTracingIfConfigured()` (or a test) registers a real
 * provider afterwards.
 */
function getTracer() {
  return trace.getTracer('sci-healthcare-backend', APP_VERSION);
}

/**
 * Runs `fn` as one span named `name`.
 *
 * The whole point is spans for the parts auto-instrumentation cannot see —
 * the indexer cycle, the calls into Soroban RPC, the projection
 * transaction — written against `@opentelemetry/api` so the code is
 * identical whether or not the SDK is running. An error is recorded on the
 * span and rethrown untouched; the span always ends.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(name, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        ...(err instanceof Error ? { message: err.message } : {}),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
