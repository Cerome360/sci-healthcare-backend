#!/usr/bin/env node
/**
 * Load test for the read API (issue #66).
 *
 * Seeds a dedicated throwaway SQLite database (prisma/loadtest.db — never the
 * dev or production database), starts the API against it, and drives three
 * scenarios with autocannon:
 *
 *   mixed      a realistic list/detail mix from many simulated clients
 *   single     one client, to show what the per-IP rate limiter does
 *   sort-probe /vouchers?sort=amount against its index-ordered twin
 *
 * Usage:
 *   npm run loadtest                          # full run, ~40 s after seeding
 *   npm run loadtest -- --duration 30 --clients 600
 *   npm run loadtest -- --url http://127.0.0.1:8080   # target your own instance
 *   npm run loadtest -- --out /tmp/loadtest.json      # raw autocannon results
 *
 * With --url no server is started and no database is seeded: the target must
 * already carry data (the numbers are only meaningful against seeded data).
 *
 * Every simulated client sends a distinct X-Forwarded-For value. That is not
 * a trick to hide load: an announcement brings many clients, each with its
 * own bucket in the rate limiter, and this harness reproduces that shape.
 */

import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import autocannon from 'autocannon';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOADTEST_DB = path.join(ROOT, 'prisma', 'loadtest.db');

const FUNDERS = 40;
const PROVIDERS = 25;
const VOUCHERS = 2500;
const VOUCHER_ID_BASE = 900_000_000;

/** 56-character G... addresses, deterministic and obviously synthetic. */
function accountAddress(namespace, i) {
  const digest = createHash('sha256').update(`${namespace}:${i}`).digest('hex');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  for (let c = 0; c < 55; c++) {
    out += alphabet[parseInt(digest[(c * 2) % 64] + digest[(c * 2 + 1) % 64], 16) % 32];
  }
  return `G${out}`;
}

const funderAt = (i) => accountAddress('funder', i);
const providerAt = (i) => accountAddress('provider', i);

function beneficiaryRefAt(i) {
  return createHash('sha256').update(`loadtest-beneficiary:${i % 800}`).digest('hex');
}

function amountAt(i) {
  return ((BigInt(1_000_000) + (BigInt(i) * 7_919n) % BigInt(9_000_000_000)) * 10n).toString();
}

// 100-slot status cycle: Funded 30, Claimed 20, Attested 15, Settled 20,
// Disputed 8, Refunded 7 — roughly how vouchers sit in a live system.
const STATUS_CYCLE = [
  ...Array(30).fill('Funded'),
  ...Array(20).fill('Claimed'),
  ...Array(15).fill('Attested'),
  ...Array(20).fill('Settled'),
  ...Array(8).fill('Disputed'),
  ...Array(7).fill('Refunded'),
];
const DAY = 24 * 60 * 60 * 1000;
const SERVICE_LABELS = ['Consultation', 'Lab panel', 'Vaccination', 'Dental', 'Ultrasound'];

function parseArgs(argv) {
  const opts = { duration: 15, connections: 50, clients: 400, port: 8787, url: null, out: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--duration') opts.duration = Number(value);
    else if (key === '--connections') opts.connections = Number(value);
    else if (key === '--clients') opts.clients = Number(value);
    else if (key === '--port') opts.port = Number(value);
    else if (key === '--url') opts.url = value;
    else if (key === '--out') opts.out = value;
    else throw new Error(`unknown argument: ${key}`);
  }
  return opts;
}

async function seed() {
  // The file is throwaway and ours alone, so recreate it from the schema
  // rather than reset it in place (same approach as the test suite).
  for (const suffix of ['', '-journal']) rmSync(LOADTEST_DB + suffix, { force: true });
  const url = `file:${LOADTEST_DB.replaceAll('\\', '/')}`;
  execSync('npx prisma db push --skip-generate', {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'ignore',
  });

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: url });

  const now = Date.now();
  const providers = [];
  const services = [];
  for (let i = 0; i < PROVIDERS; i++) {
    providers.push({
      address: providerAt(i),
      name: `Loadtest Clinic ${i}`,
      country: ['NG', 'KE', 'GH', 'US', 'IN'][i % 5],
      status: i % 11 === 0 ? 'Suspended' : 'Active',
      registeredAt: new Date(now - (400 - i) * DAY),
    });
    services.push(
      {
        id: `${providerAt(i)}:${1 + (i % 4)}`,
        code: 1 + (i % 4),
        label: SERVICE_LABELS[i % SERVICE_LABELS.length],
        price: amountAt(i),
        providerAddress: providerAt(i),
      },
      {
        id: `${providerAt(i)}:${5 + (i % 3)}`,
        code: 5 + (i % 3),
        label: SERVICE_LABELS[(i + 2) % SERVICE_LABELS.length],
        price: amountAt(i + 100),
        providerAddress: providerAt(i),
      },
    );
  }

  const receipts = [];
  const vouchers = [];
  for (let i = 0; i < VOUCHERS; i++) {
    const status = STATUS_CYCLE[i % 100];
    const createdAt = new Date(now - ((i * 37) % (120 * 24)) * 60 * 60 * 1000);
    const expiresAt = new Date(createdAt.getTime() + 30 * DAY);
    const claimedAt = status === 'Funded' ? null : new Date(createdAt.getTime() + 2 * DAY);
    const attestedAt = ['Attested', 'Settled', 'Disputed'].includes(status)
      ? new Date(createdAt.getTime() + 5 * DAY)
      : null;
    const disputeDeadline = attestedAt ? new Date(attestedAt.getTime() + 7 * DAY) : null;
    const settled = status === 'Settled';
    vouchers.push({
      id: String(VOUCHER_ID_BASE + i),
      funder: funderAt(i % FUNDERS),
      beneficiaryRef: beneficiaryRefAt(i),
      serviceCode: 1 + (i % 4),
      amount: amountAt(i),
      status,
      createdAt,
      expiresAt,
      claimedAt,
      attestedAt,
      disputeDeadline,
      disputeReason: status === 'Disputed' ? 3 : null,
      settledNet: settled ? ((BigInt(amountAt(i)) * 99n) / 100n).toString() : null,
      settledFee: settled ? (BigInt(amountAt(i)) / 100n).toString() : null,
      providerAddress: providerAt(i % PROVIDERS),
    });
    if (settled) {
      receipts.push({
        voucherId: String(VOUCHER_ID_BASE + i),
        beneficiaryRef: beneficiaryRefAt(i),
        providerAddress: providerAt(i % PROVIDERS),
        serviceCode: 1 + (i % 4),
        amount: amountAt(i),
        settledAt: new Date(createdAt.getTime() + 8 * DAY),
      });
    }
  }

  // Fresh file above, so plain inserts; chunked to keep statements bounded.
  await prisma.provider.createMany({ data: providers });
  await prisma.service.createMany({ data: services });
  for (let i = 0; i < vouchers.length; i += 500) {
    await prisma.voucher.createMany({ data: vouchers.slice(i, i + 500) });
  }
  for (let i = 0; i < receipts.length; i += 500) {
    await prisma.receipt.createMany({ data: receipts.slice(i, i + 500) });
  }
  await prisma.$disconnect();

  console.log(
    `seeded ${LOADTEST_DB}: ${PROVIDERS} providers, ${services.length} services, ` +
      `${vouchers.length} vouchers, ${receipts.length} receipts`,
  );
}

/** Distinct simulated source address for slot i (documentation range). */
function clientIp(i) {
  return `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`;
}

const detailId = (i) => String(VOUCHER_ID_BASE + ((i * 137) % VOUCHERS));

/** A 400-entry (by default) mixed request list, one source IP per entry. */
function buildRequestMix(clients) {
  const entries = [];
  for (let i = 0; i < clients; i++) {
    const funder = funderAt(i % FUNDERS);
    const provider = providerAt(i % PROVIDERS);
    const listVariants = [
      '/v1/vouchers?status=Funded&limit=20',
      '/v1/vouchers?status=Funded&limit=50',
      '/v1/vouchers?status=Settled&limit=20',
      '/v1/vouchers?status=Funded,Claimed&limit=20',
      `/v1/vouchers?funder=${funder}&limit=20`,
      `/v1/vouchers?provider=${provider}&limit=20`,
      `/v1/vouchers?provider=${provider}&limit=50`,
      '/v1/vouchers?status=Claimed&sort=expiresAt&limit=20',
    ];
    // 80% list, 20% detail.
    const isList = i % 10 < 8;
    const reqPath = isList ? listVariants[i % listVariants.length] : `/v1/vouchers/${detailId(i)}`;
    entries.push({ method: 'GET', path: reqPath, headers: { 'x-forwarded-for': clientIp(i) } });
  }
  return entries;
}

async function startServer(port) {
  const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, ['src/api.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      DATABASE_URL: `file:${LOADTEST_DB}`,
      STELLAR_NETWORK: 'testnet',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
      REGISTRY_CONTRACT_ID: 'CDUMMY00000000000000000000000000000000000000000000LOADTEST'.slice(0, 56),
      VOUCHER_CONTRACT_ID: 'CDUMMY00000000000000000000000000000000000000000001LOADTEST'.slice(0, 56),
      RECEIPT_CONTRACT_ID: 'CDUMMY00000000000000000000000000000000000000000002LOADTEST'.slice(0, 56),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  for (let waited = 0; waited < 30_000; waited += 250) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}:\n${stderr}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not answer /health within 30s:\n${stderr}`);
}

/**
 * autocannon has no p95: its nearest emitted percentile is p97.5, which is
 * what the report quotes alongside p50 and p99.
 */
function summarise(name, result) {
  const lat = result.latency;
  const classes = ['1xx', '2xx', '3xx', '4xx', '5xx'].filter((c) => (result[c] ?? 0) > 0);
  const lines = [
    `${name}`,
    `  requests:  ${Math.round(result.requests.average)}/s average (${result.requests.total} total)`,
    `  latency:   p50 ${lat.p50}ms  p97.5 ${lat.p97_5}ms  p99 ${lat.p99}ms  max ${lat.max}ms`,
    `  responses: ${classes.map((c) => `${result[c]} ${c}`).join(', ') || 'none'}`,
  ];
  return lines.concat(errorsLine(result), '').join('\n');
}

function errorsLine(result) {
  const bits = [];
  if (result.errors) bits.push(`${result.errors} connection errors`);
  if (result.timeouts) bits.push(`${result.timeouts} timeouts`);
  return bits.length ? `  failures:  ${bits.join(', ')}` : '  failures:  none';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let server = null;
  const results = {};

  if (opts.url) {
    console.log(`targeting ${opts.url} (no seeding, no server started)`);
  } else {
    await seed();
    server = await startServer(opts.port);
  }
  const base = opts.url ?? `http://127.0.0.1:${opts.port}`;

  try {
    console.log('\n== scenario 1: mixed list/detail, many clients ==');
    const mixed = await autocannon({
      url: base,
      connections: opts.connections,
      duration: opts.duration,
      requests: buildRequestMix(opts.clients),
    });
    results.mixed = mixed;
    console.log(summarise('mixed', mixed));

    console.log('\n== scenario 2: one client (rate limiter behaviour) ==');
    const single = await autocannon({
      url: base,
      connections: 1,
      duration: 10,
      requests: [{ method: 'GET', path: '/v1/vouchers?status=Funded&limit=20' }],
    });
    results.single = single;
    console.log(summarise('single', single));

    console.log('\n== scenario 3: sort=amount probe (5 s each) ==');
    const probeOpts = { url: base, connections: 10, duration: 5 };
    // 600 distinct source addresses per arm: in 5 s no single bucket can
    // reach the 120-request allowance, so both arms see identical headroom.
    const probePaths = (p) =>
      Array.from({ length: 600 }, (_, i) => ({
        method: 'GET',
        path: p,
        headers: { 'x-forwarded-for': clientIp(1000 + i) },
      }));
    const plain = await autocannon({
      ...probeOpts,
      requests: probePaths('/v1/vouchers?status=Settled&limit=20'),
    });
    results['sort-probe-plain'] = plain;
    console.log(summarise('status=Settled (index order)', plain));
    const sorted = await autocannon({
      ...probeOpts,
      requests: probePaths('/v1/vouchers?status=Settled&sort=amount&limit=20'),
    });
    results['sort-probe-amount'] = sorted;
    console.log(summarise('status=Settled&sort=amount', sorted));
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((resolve) => {
        server.once('exit', resolve);
        setTimeout(() => {
          server.kill('SIGKILL');
          resolve();
        }, 5000);
      });
    }
  }

  console.log(`\nhost: ${os.cpus()[0]?.model ?? 'unknown cpu'} x${os.cpus().length}, ` +
    `${(os.totalmem() / 1024 ** 3).toFixed(0)} GiB RAM, ${os.platform()} ${os.release()}, node ${process.version}`);
  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify({ opts, host: os.hostname(), results }, null, 2));
    console.log(`raw autocannon results written to ${opts.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
