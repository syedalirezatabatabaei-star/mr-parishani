import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 random bits, base64url: session ids, access and refresh tokens. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Tokens are stored only as SHA-256; a database leak does not yield usable tokens. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256 under the server secret, with a label so values made for one purpose can
 * never stand in for another (OTP codes vs CSRF tokens).
 */
export function keyedHash(secret: Buffer, label: string, value: string): string {
  return createHmac('sha256', secret).update(`${label}\u0000${value}`, 'utf8').digest('base64url');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
