import type { FieldCrypto } from '../../security/field-crypto';

/** Server secrets of the identity module, read once from the environment. */
export interface IdentitySecrets {
  /** AUTH_SECRET: keys the OTP-code and CSRF-token HMACs. */
  readonly authSecret: Buffer;
  /** FIELD_ENCRYPTION_KEY: encrypts TOTP secrets at rest. */
  readonly fieldCrypto: FieldCrypto;
  /** WEB_ORIGINS: origins allowed to send state-changing requests with the cookie. */
  readonly webOrigins: readonly string[];
}

export const IDENTITY_SECRETS = Symbol('IDENTITY_SECRETS');

/** Where a request came from; stored on the session and used for rate limits. */
export interface RequestMeta {
  readonly ip: string | null;
  /** `X-Device-Id` from the app, or the `__Host-did` cookie on web. */
  readonly deviceId: string | null;
  readonly userAgent: string | null;
}
