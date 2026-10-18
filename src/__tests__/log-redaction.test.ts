import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { redactBeneficiaryRef } from '../lib/log-redaction.js';

/**
 * #55: `beneficiaryRef` is a stable patient pseudonym. Fastify logs the
 * request URL on `incoming request` and `request completed`, and the
 * `?beneficiaryRef=…` list filters would otherwise write that reference —
 * and with it one patient's visit linkage — into every log line. The app's
 * request log serializer must scrub it, and error paths must not smuggle it
 * back in.
 */
const BENEFICIARY_REF = 'a'.repeat(32) + 'b'.repeat(32); // 64 hex chars

let loggedApp: FastifyInstance | null = null;

afterEach(async () => {
  if (loggedApp) {
    await loggedApp.close();
    loggedApp = null;
  }
});

/** An app logging at info into an in-memory array of JSON lines. */
async function appWithCapturedLogs(): Promise<string[]> {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  loggedApp = await buildApp({ logger: { level: 'info', stream } });
  return lines;
}

function expectNoRef(lines: readonly string[]): void {
  const all = lines.join('');
  expect(lines.length).toBeGreaterThan(0);
  expect(all).not.toContain(BENEFICIARY_REF);
}

describe('beneficiaryRef redaction in request logs (#55)', () => {
  it('redacts the ref from voucher list request logging', async () => {
    const lines = await appWithCapturedLogs();
    await loggedApp!.inject({
      method: 'GET',
      url: `/vouchers?beneficiaryRef=${BENEFICIARY_REF}&status=Funded`,
    });

    expectNoRef(lines);
    // The request really was logged — a silent logger would pass the test above
    // without proving anything.
    expect(lines.some((l) => l.includes('incoming request'))).toBe(true);
    expect(lines.some((l) => l.includes('beneficiaryRef=%5Bredacted%5D'))).toBe(true);
  });

  it('redacts the ref from receipt list request logging', async () => {
    const lines = await appWithCapturedLogs();
    await loggedApp!.inject({
      method: 'GET',
      url: `/receipts?beneficiaryRef=${BENEFICIARY_REF}`,
    });

    expectNoRef(lines);
    expect(lines.some((l) => l.includes('incoming request'))).toBe(true);
  });

  it('keeps the ref out of error-path logging too', async () => {
    // A 400 (rejected by the route's query validation) still logs the URL on
    // `incoming request`, the rejection line itself, and `request completed`.
    const lines = await appWithCapturedLogs();
    const res = await loggedApp!.inject({
      method: 'GET',
      url: `/receipts?beneficiaryRef=${BENEFICIARY_REF}&provider=not-an-address`,
    });
    expect(res.statusCode).toBe(400);

    expectNoRef(lines);
    expect(lines.some((l) => l.includes('request rejected'))).toBe(true);
  });

  it('does not touch other query parameters or path segments', async () => {
    const lines = await appWithCapturedLogs();
    await loggedApp!.inject({
      method: 'GET',
      url: `/vouchers?provider=${'C'.repeat(56)}&beneficiaryRef=${BENEFICIARY_REF}&limit=10`,
    });

    const incoming = lines.find((l) => l.includes('incoming request'));
    expect(incoming).toBeDefined();
    expect(incoming).toContain(`provider=${'C'.repeat(56)}`);
    expect(incoming).toContain('limit=10');
    expect(incoming).toContain('beneficiaryRef=%5Bredacted%5D');
    expect(incoming).not.toContain(BENEFICIARY_REF);
  });
});

describe('redactBeneficiaryRef', () => {
  it('masks the ref wherever it sits in the query string', () => {
    expect(redactBeneficiaryRef(`/vouchers?beneficiaryRef=${BENEFICIARY_REF}`)).toBe(
      '/vouchers?beneficiaryRef=%5Bredacted%5D',
    );
    expect(redactBeneficiaryRef(`/v?x=1&beneficiaryRef=${BENEFICIARY_REF}&y=2`)).toBe(
      '/v?x=1&beneficiaryRef=%5Bredacted%5D&y=2',
    );
    expect(redactBeneficiaryRef(`/v?status=Funded&beneficiaryRef=abc`)).toBe(
      '/v?status=Funded&beneficiaryRef=%5Bredacted%5D',
    );
  });

  it('leaves URLs without the parameter unchanged', () => {
    expect(redactBeneficiaryRef('/vouchers?status=Funded&limit=10')).toBe(
      '/vouchers?status=Funded&limit=10',
    );
    expect(redactBeneficiaryRef('/receipts/123')).toBe('/receipts/123');
  });

  it('masks a trailing empty value only when one is present', () => {
    // `beneficiaryRef=` with no value carries nothing to hide, and the
    // route's validator rejects it; the URL is left as-is.
    expect(redactBeneficiaryRef('/vouchers?beneficiaryRef=')).toBe('/vouchers?beneficiaryRef=');
  });
});
