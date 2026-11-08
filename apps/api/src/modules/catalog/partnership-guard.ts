import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * The partnership form's anti-bot measures (owner 1405/08/10): no outside service (rule 18),
 * nothing for a person to solve. A light proof of work the page computes, counters per mobile
 * and per address, a daily ceiling on the SMS it may cause, and a field only bots fill.
 * Technical limits, not business numbers (decision 5 of the portal decisions).
 */
export const PARTNERSHIP_LIMITS = {
  /** Leading zero bits of SHA-256(challenge:counter): about 130 thousand tries in the page. */
  powBits: 17,
  powSeconds: 10 * 60,
  /** Requests one address may send in an hour; one mobile in a day. */
  submitsPerIpPerHour: 5,
  submitsPerMobilePerDay: 3,
  /** The codes this form may send in a day, whoever asks: a ceiling on the SMS bill. */
  codesPerDay: 300,
} as const;

/** Leading zero bits of a digest. */
export function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export class ProofOfWork {
  constructor(
    private readonly secret: Buffer,
    private readonly redis: Redis,
    private readonly bits: number = PARTNERSHIP_LIMITS.powBits,
  ) {}

  private sign(body: string) {
    return createHmac('sha256', this.secret).update(`pow\u0000${body}`).digest('base64url');
  }

  /** A challenge: its expiry and randomness, signed so the page cannot make its own. */
  issue(now = new Date()): { challenge: string; bits: number; expiresAt: string } {
    const expires = now.getTime() + PARTNERSHIP_LIMITS.powSeconds * 1000;
    const body = `${String(expires)}.${randomBytes(12).toString('base64url')}`;
    return {
      challenge: `${body}.${this.sign(body)}`,
      bits: this.bits,
      expiresAt: new Date(expires).toISOString(),
    };
  }

  /** Whether the counter solves a live, genuine challenge never used before. */
  async verify(challenge: string, counter: number, now = new Date()): Promise<boolean> {
    const parts = challenge.split('.');
    if (parts.length !== 3) return false;
    const [expires, nonce, mac] = parts as [string, string, string];
    const expected = Buffer.from(this.sign(`${expires}.${nonce}`));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
    if (!(Number(expires) > now.getTime())) return false;
    const digest = createHash('sha256')
      .update(`${challenge}:${String(counter)}`)
      .digest();
    if (leadingZeroBits(digest) < this.bits) return false;
    // Once only: a solved challenge cannot be replayed.
    const fresh = await this.redis.set(
      `catalog:pow:${nonce}`,
      '1',
      'EX',
      PARTNERSHIP_LIMITS.powSeconds,
      'NX',
    );
    return fresh !== null;
  }
}
