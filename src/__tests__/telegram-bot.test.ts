import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  computeSignature,
  createWebhookServer,
  formatTelegramMessage,
  sendTelegramNotification,
  verifySignature,
  type WebhookVoucherPayload,
} from '../../examples/telegram-bot/dist/index.js';

describe('examples/telegram-bot', () => {
  const secret = 'test-secret-key-12345';
  let server: ReturnType<typeof createWebhookServer>;
  let serverUrl: string;
  const postedMessages: string[] = [];

  beforeAll(async () => {
    server = createWebhookServer({
      webhookSecret: secret,
      botToken: 'mock-token',
      chatId: '987654321',
      logger: () => {},
      onMessagePosted: (msg: string) => {
        postedMessages.push(msg);
      },
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  });

  describe('signature verification', () => {
    it('verifies valid HMAC-SHA256 signature in raw hex format', () => {
      const payload = JSON.stringify({ event: 'voucher_funded', voucherId: '100' });
      const sig = computeSignature(payload, secret);
      expect(verifySignature(payload, sig, secret)).toBe(true);
    });

    it('verifies signature prefixed with sha256=', () => {
      const payload = JSON.stringify({ event: 'voucher_funded', voucherId: '100' });
      const sig = `sha256=${computeSignature(payload, secret)}`;
      expect(verifySignature(payload, sig, secret)).toBe(true);
    });

    it('rejects tampered payload', () => {
      const payload = JSON.stringify({ event: 'voucher_funded', voucherId: '100' });
      const sig = computeSignature(payload, secret);
      const tampered = JSON.stringify({ event: 'voucher_funded', voucherId: '101' });
      expect(verifySignature(tampered, sig, secret)).toBe(false);
    });

    it('rejects signature generated with different secret', () => {
      const payload = JSON.stringify({ event: 'voucher_funded', voucherId: '100' });
      const sig = computeSignature(payload, 'wrong-secret');
      expect(verifySignature(payload, sig, secret)).toBe(false);
    });

    it('rejects missing or empty signature', () => {
      const payload = JSON.stringify({ event: 'voucher_funded', voucherId: '100' });
      expect(verifySignature(payload, undefined, secret)).toBe(false);
      expect(verifySignature(payload, '', secret)).toBe(false);
    });
  });

  describe('message formatting and privacy guards', () => {
    it('formats voucher funded notification without beneficiary identifiers', () => {
      const payload: WebhookVoucherPayload = {
        event: 'voucher_funded',
        voucherId: '0001',
        status: 'Funded',
        amountDisplay: '3.0000000',
        serviceCode: 101,
        serviceLabel: 'Consultation',
        ledger: 5000,
      };

      const msg = formatTelegramMessage(payload);
      expect(msg).toContain('New Care Voucher Funded!');
      expect(msg).toContain('0001');
      expect(msg).toContain('3.0000000 USDC');
      expect(msg).toContain('Consultation');
      expect(msg).not.toContain('beneficiary');
    });

    it('strictly throws when beneficiary references are present', () => {
      const leakPayload = {
        event: 'voucher_funded',
        voucherId: '0001',
        status: 'Funded',
        beneficiaryRef: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      };

      expect(() => formatTelegramMessage(leakPayload as unknown as WebhookVoucherPayload)).toThrow(
        /Privacy violation/,
      );
    });

    it('escapes special characters to prevent HTML injection', () => {
      const payload: WebhookVoucherPayload = {
        event: 'voucher_funded',
        voucherId: '<script>alert(1)</script>',
        status: 'Funded & Verified',
      };
      const msg = formatTelegramMessage(payload);
      expect(msg).toContain('&lt;script&gt;');
      expect(msg).toContain('&amp;');
      expect(msg).not.toContain('<script>');
    });
  });

  describe('webhook HTTP server', () => {
    it('responds to health probe', async () => {
      const res = await fetch(`${serverUrl}/health`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe('ok');
    });

    it('rejects webhook without signature header', async () => {
      const payload = JSON.stringify({ event: 'voucher_funded', voucherId: '123', status: 'Funded' });
      const res = await fetch(`${serverUrl}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_signature');
    });

    it('rejects webhook with invalid signature', async () => {
      const payload = JSON.stringify({ event: 'voucher_funded', voucherId: '123', status: 'Funded' });
      const res = await fetch(`${serverUrl}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-SCI-Signature': 'deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd',
        },
        body: payload,
      });

      expect(res.status).toBe(401);
    });

    it('accepts signed webhook and delivers notification', async () => {
      postedMessages.length = 0;
      const payload = JSON.stringify({
        event: 'voucher_funded',
        voucherId: 'voucher-abc',
        status: 'Funded',
        amountDisplay: '5.0000000',
        serviceLabel: 'Malaria screening',
      });
      const sig = computeSignature(payload, secret);

      const res = await fetch(`${serverUrl}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-SCI-Signature': sig,
        },
        body: payload,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; status: string; voucherId: string };
      expect(body.ok).toBe(true);
      expect(body.status).toBe('delivered');
      expect(body.voucherId).toBe('voucher-abc');

      expect(postedMessages.length).toBe(1);
      expect(postedMessages[0]).toContain('voucher-abc');
      expect(postedMessages[0]).toContain('Malaria screening');
      expect(postedMessages[0]).not.toContain('beneficiary');
    });

    it('rejects webhook with beneficiary leakage even if signature is valid', async () => {
      const leakPayload = JSON.stringify({
        event: 'voucher_funded',
        voucherId: 'voucher-leak',
        status: 'Funded',
        beneficiaryRef: '0123456789abcdef',
      });
      const sig = computeSignature(leakPayload, secret);

      const res = await fetch(`${serverUrl}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-SCI-Signature': sig,
        },
        body: leakPayload,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('payload_rejected');
      expect(body.message).toContain('Privacy violation');
    });

    it('sends Telegram notification in mock mode', async () => {
      const res = await sendTelegramNotification('mock-token', '12345', 'Hello clinic');
      expect(res.ok).toBe(true);
      expect(res.result).toBeDefined();
    });
  });
});
