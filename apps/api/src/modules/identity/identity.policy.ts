/**
 * Login parameters that stay in code. Limits and lifetimes that administrators tune are
 * versioned configuration (task 0-6, ADR-006): `identity.otp`, `identity.staff_login`,
 * `identity.lockout` and `identity.session`, read through the CONFIG port. What remains
 * here is protocol or internal tuning, changed only by a reviewed code change.
 */
export const IDENTITY_CONSTANTS = {
  /** Digits in a login code; the SMS template and the input schemas assume six. */
  otpLength: 6,
  /** last_seen_at is written at most this often per session. */
  sessionTouchIntervalSeconds: 60,
  sms: {
    /** Delivery attempts per job; the job is dropped anyway once the code expires. */
    attempts: 5,
    /** First retry delay; doubles each time. */
    backoffMs: 2_000,
  },
} as const;
