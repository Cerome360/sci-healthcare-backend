import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import compress from '@fastify/compress';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { env } from './env.js';
import {
  CACHE_CONTROL,
  cacheEtag,
  cachePolicy,
  lastIndexedLedger,
  matchesEtag,
  NO_STORE,
} from './lib/cache.js';
import { errorEnvelope } from './lib/errors.js';
import { redactBeneficiaryRef } from './lib/log-redaction.js';
import { httpDuration, httpRequests, registry } from './lib/metrics.js';
import { APP_VERSION } from './lib/version.js';
import { governanceRoutes } from './routes/governance.js';
import { healthRoutes } from './routes/health.js';
import { providerRoutes } from './routes/providers.js';
import { receiptRoutes } from './routes/receipts.js';
import { serviceRoutes } from './routes/services.js';
import { streamRoutes } from './routes/stream.js';
import { voucherRoutes } from './routes/vouchers.js';
import { DEFAULT_RATE_LIMIT } from './lib/rate-limits.js';

/**
 * Request ids are opaque, bounded and safe to put in a log line. Anything
 * else in the header is ignored and replaced, so a caller cannot inject
 * control characters into logs or make them unbounded.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function genReqId(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

export type BuildAppOptions = {
  logger?: FastifyServerOptions['logger'];
};

/**
 * The request half of a log line (`incoming request`, `request completed`)
 * is serialized here instead of by Fastify's default, so the `beneficiaryRef`
 * query parameter is masked before it reaches the log (#55). The shape is
 * deliberately the same fields the default serializer emits, with only the
 * URL run through `redactBeneficiaryRef`. Error logs carry `{ err }` only —
 * validation messages name the failing parameter but never echo its value.
 */
function serializeRequestForLog(req: FastifyRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: redactBeneficiaryRef(req.url),
    version: req.headers['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket.remotePort,
  };
}

type LoggerOption = NonNullable<FastifyServerOptions['logger']>;

function withRedactedLogging(logger: FastifyServerOptions['logger']): LoggerOption | false {
  if (!logger) return false;
  // A ready-made logger instance is the caller's; only the plain options
  // object can be extended with our request serializer.
  if (typeof logger !== 'object' || !('level' in logger)) return logger as LoggerOption;
  const options = logger as { serializers?: Record<string, (value: unknown) => unknown> } & object;
  return {
    ...options,
    serializers: { ...options.serializers, req: serializeRequestForLog },
  } as LoggerOption;
}

async function registerRoutes(scope: FastifyInstance): Promise<void> {
  await scope.register(healthRoutes);
  await scope.register(providerRoutes);
  await scope.register(serviceRoutes);
  await scope.register(voucherRoutes);
  await scope.register(receiptRoutes);
  await scope.register(governanceRoutes);
  await scope.register(streamRoutes);
}

/**
 * Builds the HTTP API without starting the indexer or listening.
 *
 * Kept separate from `index.ts` so route tests can drive the real app
 * through `app.inject()` against a throwaway database.
 */
export async function buildApp(
  opts: BuildAppOptions = { logger: { level: env.LOG_LEVEL } },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: withRedactedLogging(opts.logger),
    trustProxy: true,
    genReqId,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'SCI Healthcare API',
        description:
          'Read-only API for the SCI Healthcare care-voucher protocol on Stellar. ' +
          'All monetary amounts are decimal strings representing i128 values in ' +
          'base units (stroops). A 7-decimal Stellar asset like USDC uses 10^7 ' +
          'base units per whole token, so "30000000" = 3.0000000 USDC. Amounts ' +
          'are strings, not numbers, because they can exceed Number.MAX_SAFE_INTEGER.',
        // Same source as GET /version, so the spec cannot drift from the
        // package the way a literal did.
        version: APP_VERSION,
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET'],
  });

  await app.register(compress);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, DEFAULT_RATE_LIMIT);

  // Every response, including errors and 404s, carries the id that appears
  // in the matching log line, plus the configured Stellar network name.
  //
  // The same hook adds HTTP caching for the read routes. It lives here, in
  // one place, so routes stay unchanged and cannot forget it. The validator
  // is the indexer cursor plus the request URL: the data cannot have changed
  // without a new ledger, and a different filter is a different resource.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    reply.header('x-stellar-network', env.STELLAR_NETWORK);

    const policy = cachePolicy(req.routeOptions.url);
    if (policy === NO_STORE) {
      reply.header('cache-control', NO_STORE);
      return payload;
    }
    if (policy === null) return payload;

    // Errors (a missing voucher, a rate-limited client, a database failure)
    // must not be reused: the next request may well succeed.
    if (reply.statusCode !== 200) {
      reply.header('cache-control', NO_STORE);
      return payload;
    }

    reply.header('cache-control', CACHE_CONTROL);
    const lastLedger = await lastIndexedLedger();
    // The read model could not be inspected, so there is no honest validator
    // to offer; serve the response uncacheable rather than lie about it.
    if (lastLedger === null) {
      reply.header('cache-control', NO_STORE);
      return payload;
    }

    const etag = cacheEtag(lastLedger, req.url);
    reply.header('etag', etag);

    if (matchesEtag(req.headers['if-none-match'], etag)) {
      // Returning null drops the body; Fastify handles 304 framing.
      reply.code(304);
      return null;
    }

    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    const { statusCode, body } = errorEnvelope(err);
    if (statusCode >= 500) req.log.error({ err }, 'request failed');
    else req.log.warn({ err }, 'request rejected');
    reply.code(statusCode).send(body);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: 'route_not_found',
      message: `Route ${req.method} ${req.url} not found`,
    });
  });

  app.get('/openapi.json', { schema: { hide: true } }, async () => {
    return app.swagger();
  });

  // Labelled by route pattern, not URL, so ids in paths cannot blow up the
  // number of series. Unmatched requests share one label.
  app.addHook('onResponse', async (req, reply) => {
    if (req.routeOptions.url === '/metrics') return;
    const labels = {
      method: req.method,
      route: req.routeOptions.url ?? 'unmatched',
      status_code: String(reply.statusCode),
    };
    httpRequests.inc(labels);
    httpDuration.observe(labels, reply.elapsedTime / 1000);
  });

  // Scraped by a monitoring system on a fixed interval, so it must not share
  // the public per-IP budget.
  app.get(
    '/metrics',
    { schema: { hide: true }, config: { rateLimit: false } },
    async (_req, reply) => {
      reply.header('content-type', registry.contentType);
      return registry.metrics();
    },
  );

  // `/v1` is the canonical API. The unversioned paths stay as aliases for
  // clients already deployed against them, and say so on every response.
  await app.register(
    async (v1) => {
      await registerRoutes(v1);
    },
    { prefix: '/v1' },
  );

  await app.register(async (legacy) => {
    legacy.addHook('onSend', async (req, reply, payload) => {
      reply.header('deprecation', 'true');
      reply.header('link', `<${v1Path(req.url)}>; rel="successor-version"`);
      return payload;
    });
    await registerRoutes(legacy);
  });

  return app;
}

function v1Path(url: string): string {
  const path = url.replace(/[\r\n]/g, '');
  if (path.startsWith('/v1/') || path === '/v1') return path;
  return `/v1${path.startsWith('/') ? path : `/${path}`}`;
}
