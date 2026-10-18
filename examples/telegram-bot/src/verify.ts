import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Computes an HMAC-SHA256 hex signature over the given raw payload.
 */
export function computeSignature(payload: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verifies that the incoming X-SCI-Signature header matches the expected HMAC-SHA256
 * signature over the raw payload using constant-time comparison to prevent timing attacks.
 * Accepts signature in form of raw hex string or "sha256=<hex>".
 */
export function verifySignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;

  const cleanSignature = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice(7).trim()
    : signatureHeader.trim();

  const expectedSignature = computeSignature(rawBody, secret);

  if (cleanSignature.length !== expectedSignature.length) {
    return false;
  }

  const cleanBuf = Buffer.from(cleanSignature, 'hex');
  const expectedBuf = Buffer.from(expectedSignature, 'hex');

  if (cleanBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(cleanBuf, expectedBuf);
}
