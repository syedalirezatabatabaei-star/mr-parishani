import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { requiredEnv } from '../../infra/env';

/**
 * Service codes (doc 12 §6.3): six random digits, sent to the borrower once and never
 * stored; the database keeps only an HMAC bound to its authorization, under a key derived
 * from AUTH_SECRET for this purpose alone (so it signs nothing else).
 */
export interface ServiceCodeHasher {
  hash(authorizationId: string, code: string): string;
  matches(authorizationId: string, code: string, hash: string): boolean;
}

export const SERVICE_CODES = Symbol('SERVICE_CODES');

export function newServiceCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export class HmacServiceCodes implements ServiceCodeHasher {
  private readonly key: Buffer;

  constructor(secret: Buffer) {
    this.key = createHmac('sha256', secret).update('sepehr:service-code').digest();
  }

  hash(authorizationId: string, code: string): string {
    return createHmac('sha256', this.key).update(`${authorizationId}:${code}`).digest('base64url');
  }

  matches(authorizationId: string, code: string, hash: string): boolean {
    const a = Buffer.from(this.hash(authorizationId, code));
    const b = Buffer.from(hash);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export function serviceCodesFromEnv(): ServiceCodeHasher {
  return new HmacServiceCodes(Buffer.from(requiredEnv('AUTH_SECRET'), 'base64'));
}
