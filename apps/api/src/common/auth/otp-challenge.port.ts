/**
 * Port to the identity module's one-time codes, for a confirmation other than login
 * (task 3-5: consent to the credit check, doc 03 §8-6). The same code, delivery, expiry,
 * resend cooldown and lockout as the login code, kept apart per purpose so a consent code
 * never logs anyone in and a login code never consents. The identity module provides it
 * under {@link OTP_CHALLENGE}.
 */
export interface OtpChallengeMeta {
  readonly ip: string | null;
  readonly deviceId?: string | null;
}

export interface OtpChallenge {
  /** Sends a code to `mobile` (9XXXXXXXXX) for `purpose`; 429 within the limits. */
  send(
    mobile: string,
    purpose: string,
    meta: OtpChallengeMeta,
    now?: Date,
  ): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }>;
  /** Consumes a correct code, else 401 `invalid_code` (and counts toward the lockout). */
  verify(
    mobile: string,
    purpose: string,
    code: string,
    meta: OtpChallengeMeta,
    now?: Date,
  ): Promise<void>;
}

export const OTP_CHALLENGE = Symbol('OTP_CHALLENGE');
