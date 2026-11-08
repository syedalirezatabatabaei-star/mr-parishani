import { createHmac } from 'node:crypto';

/**
 * TOTP for the staff accounts of the end-to-end stack (RFC 6238: 30-second steps, six
 * digits, SHA-1), as an authenticator app computes it. Mirrors apps/api identity/totp.ts.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
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

export const totpStep = (epochMs: number) => Math.floor(epochMs / 30_000);

export function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * A code for a step not used yet: the API refuses a step at or before the last accepted
 * (replay) and allows one step of drift, so after `lastStep` the next one is taken.
 */
export function freshCode(secretBase32: string, lastStep: number, now = Date.now()) {
  const step = Math.max(totpStep(now), lastStep + 1);
  return { step, code: hotp(base32Decode(secretBase32), step) };
}
