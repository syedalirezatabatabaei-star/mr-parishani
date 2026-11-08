import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238) with the parameters every authenticator app supports: HMAC-SHA1,
 * 30-second steps, 6 digits. Written here rather than taken from a library; checked
 * against the RFC's test vectors.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 as authenticator apps expect. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(epochMs: number): number {
  return Math.floor(epochMs / 1000 / STEP_SECONDS);
}

/** HOTP (RFC 4226) value for a counter. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The time step a code matches, allowing one step of clock drift either way, or null.
 * The caller must reject a step at or before the last one accepted (replay).
 */
export function verifyTotp(secretBase32: string, code: string, epochMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(epochMs);
  for (const step of [current, current - 1, current + 1]) {
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

/** otpauth:// URI for the QR code shown at enrollment. */
export function totpUri(secretBase32: string, accountName: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
