import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { keyIdOf, keyPrefix, singleKey, type KeyRing } from './key-ring';

/**
 * Field-level encryption (rule 27): AES-256-GCM with a random 96-bit IV per value.
 * Stored form: `<key>.<iv>.<ciphertext>.<tag>`, each part base64url; `<key>` is `v1` for key 1
 * (the only form before key rotation, R4) and `k<N>` for key N. `context` is bound as
 * associated data, so a value copied to another column or row does not decrypt there.
 */
const TAG_LENGTH = 16;

export class FieldCrypto {
  private readonly ring: KeyRing;

  constructor(keyOrRing: Buffer | KeyRing) {
    this.ring = Buffer.isBuffer(keyOrRing) ? singleKey(keyOrRing) : keyOrRing;
    for (const key of this.ring.keys.values()) {
      if (key.length !== 32) throw new Error('FieldCrypto needs a 32-byte key');
    }
    if (!this.ring.keys.has(this.ring.active)) throw new Error('FieldCrypto: no active key');
  }

  /** The key that writes. */
  get activeKeyId(): number {
    return this.ring.active;
  }

  encrypt(plaintext: string, context: string): string {
    const key = this.ring.keys.get(this.ring.active) as Buffer;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [keyPrefix(this.ring.active), iv, ciphertext, tag]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  decrypt(stored: string, context: string): string {
    const [, iv, ciphertext, tag] = stored.split('.');
    const keyId = keyIdOf(stored);
    const key = keyId === null ? undefined : this.ring.keys.get(keyId);
    if (!key || !iv || ciphertext === undefined || !tag) {
      throw new Error('Unrecognized encrypted field format');
    }
    // A fixed tag length: a shortened tag is rejected instead of weakening the check.
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Written under the key that writes now: nothing to re-encrypt. */
  isCurrent(stored: string): boolean {
    return keyIdOf(stored) === this.ring.active;
  }
}
