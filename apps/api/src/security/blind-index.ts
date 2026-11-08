import { createHmac } from 'node:crypto';
import { keyIdOf, keyPrefix, singleKey, type KeyRing } from './key-ring';

/**
 * Blind index for encrypted fields (rule 27): a keyed HMAC-SHA256 of the normalized value,
 * so equal values can be found and kept unique without decrypting anything. The key
 * (BLIND_INDEX_KEY) is separate from the encryption key: one leaking does not expose the
 * other. The domain keeps equal digits of different kinds apart (a national ID is never
 * a Sheba). Stored form `<key>.<base64url>`: `v1` for key 1, `k<N>` for key N (R4).
 */
export type BlindIndexDomain = 'national_id' | 'legal_id' | 'sheba' | 'instrument_number';

export class BlindIndex {
  private readonly ring: KeyRing;

  constructor(keyOrRing: Buffer | KeyRing) {
    this.ring = Buffer.isBuffer(keyOrRing) ? singleKey(keyOrRing) : keyOrRing;
    for (const key of this.ring.keys.values()) {
      if (key.length !== 32) throw new Error('BlindIndex needs a 32-byte key');
    }
    if (!this.ring.keys.has(this.ring.active)) throw new Error('BlindIndex: no active key');
  }

  /** The key that writes. */
  get activeKeyId(): number {
    return this.ring.active;
  }

  /** The index under the key that writes now. */
  of(domain: BlindIndexDomain, normalizedValue: string): string {
    return this.under(this.ring.active, domain, normalizedValue);
  }

  /**
   * The index under every key of the ring, the active one first (R4, ADR-040): a lookup finds
   * a row still indexed under an older key while a rotation is under way, and a uniqueness
   * check sees it.
   */
  allOf(domain: BlindIndexDomain, normalizedValue: string): string[] {
    const others = [...this.ring.keys.keys()].filter((id) => id !== this.ring.active).sort();
    return [this.ring.active, ...others].map((id) => this.under(id, domain, normalizedValue));
  }

  /**
   * The index under the ring's lowest key: the same value whichever key writes, for a lock
   * taken by every process of a rotation (ADR-040). Never stored.
   */
  stableOf(domain: BlindIndexDomain, normalizedValue: string): string {
    return this.under(Math.min(...this.ring.keys.keys()), domain, normalizedValue);
  }

  private under(id: number, domain: BlindIndexDomain, normalizedValue: string): string {
    const key = this.ring.keys.get(id) as Buffer;
    const mac = createHmac('sha256', key).update(`${domain}\u0000${normalizedValue}`);
    return `${keyPrefix(id)}.${mac.digest('base64url')}`;
  }

  /** Indexed under the key that writes now: nothing to rebuild. */
  isCurrent(stored: string): boolean {
    return keyIdOf(stored) === this.ring.active;
  }
}

/** The last four characters, the only part of an identifier ever shown or logged. */
export const lastFour = (value: string) => value.slice(-4);
