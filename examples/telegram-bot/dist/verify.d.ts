/**
 * Computes an HMAC-SHA256 hex signature over the given raw payload.
 */
export declare function computeSignature(payload: string | Buffer, secret: string): string;
/**
 * Verifies that the incoming X-SCI-Signature header matches the expected HMAC-SHA256
 * signature over the raw payload using constant-time comparison to prevent timing attacks.
 * Accepts signature in form of raw hex string or "sha256=<hex>".
 */
export declare function verifySignature(rawBody: string | Buffer, signatureHeader: string | undefined | null, secret: string): boolean;
