import * as z from 'zod';
import { normalizeDigits } from '../text/digits.js';
import { normalizeMobile } from '../text/mobile.js';
import { normalizePersianText } from '../text/persian.js';

/** `web` gets an HttpOnly cookie; `mobile` gets an access and a refresh token. */
export const authClientSchema = z.enum(['web', 'mobile']);
export type AuthClient = z.infer<typeof authClientSchema>;

/** Any common way of writing an Iranian mobile, normalized to 9XXXXXXXXX. */
export const mobileSchema = z.string().transform((value, ctx) => {
  const mobile = normalizeMobile(value);
  if (mobile === null) {
    ctx.addIssue({ code: 'custom', message: 'invalid mobile number' });
    return z.NEVER;
  }
  return mobile;
});

/** Six digits, written in Persian, Arabic-Indic or ASCII: normalized before use (rule 23). */
const codeSchema = z
  .string()
  .transform(normalizeDigits)
  .pipe(z.string().regex(/^\d{6}$/));

export const otpRequestSchema = z.object({ mobile: mobileSchema });
export type OtpRequest = z.input<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  mobile: mobileSchema,
  code: codeSchema,
  client: authClientSchema,
});
export type OtpVerify = z.input<typeof otpVerifySchema>;

/**
 * A staff or center user proving their own mobile (task 4-6; owner: by a code sent to it,
 * never only typed): asked, then verified with the code.
 */
export const accountMobileRequestSchema = z.strictObject({ mobile: mobileSchema });
export const accountMobileVerifySchema = z.strictObject({ mobile: mobileSchema, code: codeSchema });
export const accountMobileViewSchema = z.object({
  /** The last four digits only: the full number is the user's own and never echoed. */
  mobileLastFour: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  verified: z.boolean(),
  verifiedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AccountMobileView = z.infer<typeof accountMobileViewSchema>;

/**
 * ف۱۲ (owner 1405/07/26, option «ب»): a signed-in patient replaces their login mobile with
 * one proved by a code sent to it; the previous one is told. The answer echoes the last four
 * digits only.
 */
export const patientMobileChangeRequestSchema = z.strictObject({ mobile: mobileSchema });
export const patientMobileChangeVerifySchema = z.strictObject({
  mobile: mobileSchema,
  code: codeSchema,
});
export const patientMobileChangedSchema = z.object({
  mobileLastFour: z.string().regex(/^\d{4}$/),
  /** The patient's other sessions, ended. */
  sessionsEnded: z.int().nonnegative(),
});
export type PatientMobileChanged = z.infer<typeof patientMobileChangedSchema>;

/** Normalized before it is stored (rule 23), as the lead module's reasons. */
const staffText = (min: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(500));

/**
 * ف۱۲ ب۲ (owner 1405/07/26): the previous mobile is lost, so staff replace it, by two people
 * as 0085. The first finds the account by its current mobile and sends a code to the new one;
 * the patient reads it back, and the first proposes with it and the evidence seen. A second,
 * never the first, approves; refusing takes one. Answers carry the last four digits only.
 */
export const patientMobileChangeCodeSchema = z.strictObject({
  currentMobile: mobileSchema,
  newMobile: mobileSchema,
});
export const proposePatientMobileChangeSchema = z.strictObject({
  currentMobile: mobileSchema,
  newMobile: mobileSchema,
  code: codeSchema,
  reason: staffText(3),
  evidence: staffText(3),
});
export const decidePatientMobileChangeSchema = z.strictObject({ reason: staffText(3) });

const lastFourSchema = z.string().regex(/^\d{4}$/);

export const patientMobileChangeViewSchema = z.strictObject({
  id: z.uuid(),
  accountId: z.uuid(),
  fromLastFour: lastFourSchema,
  toLastFour: lastFourSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  reason: z.string(),
  evidence: z.string(),
  requestedAt: z.iso.datetime({ offset: true }),
  requestedByMe: z.boolean(),
  decidedAt: z.iso.datetime({ offset: true }).nullable(),
  decisionReason: z.string().nullable(),
  /** Approved: the patient's sessions it ended. */
  sessionsEnded: z.int().nonnegative().nullable(),
});
export type PatientMobileChangeView = z.infer<typeof patientMobileChangeViewSchema>;

export const staffLoginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(256),
  client: authClientSchema,
});
export type StaffLogin = z.input<typeof staffLoginSchema>;

/** Task 9-3 (R2): a staff member changes their own password with the current one. */
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});

/** How many other sessions the change ended (ASVS 3.3.3). */
export const passwordChangedSchema = z.object({ otherSessionsEnded: z.int() });

export const totpCodeSchema = z.object({ code: codeSchema });
export type TotpCode = z.input<typeof totpCodeSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(256) });
export type RefreshRequest = z.input<typeof refreshSchema>;

/** Tokens returned to the mobile client. */
export interface MobileTokens {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
}

/** An active session as shown on the device-management page. */
export interface SessionSummary {
  readonly id: string;
  readonly client: AuthClient;
  readonly deviceLabel: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly current: boolean;
}

/*
 * Response bodies (task 2-11): the API declares them with `@ZodResponse`, the OpenAPI
 * document carries them, and the generated client is typed by them (CLAUDE.md §5).
 */

const sessionStageSchema = z.enum(['mfa_pending', 'active']);
const isoInstant = z.iso.datetime({ offset: true });

/** `GET /auth/me`. */
export const meResponseSchema = z.object({
  accountId: z.uuid(),
  stage: sessionStageSchema,
  client: authClientSchema,
  /** On web, the token of every state-changing request (`x-csrf-token`); null on mobile. */
  csrfToken: z.string().nullable(),
  /**
   * Task 9-3 (owner, question 3): an internal staff member proves a mobile first; until then
   * only their own account's endpoints answer, and the panel shows the form it requires.
   */
  mobileRequired: z.boolean(),
});

/** `POST /auth/totp/reauth` (task 9-3, R1): sensitive actions are open until this moment. */
export const reauthResponseSchema = z.object({ reauthenticatedUntil: isoInstant });

/** `POST /auth/otp/request`: the same answer whether or not the mobile has an account. */
export const otpRequestedSchema = z.object({
  expiresInSeconds: z.int().positive(),
  resendAfterSeconds: z.int().nonnegative(),
});

/** A sign-in: web gets the cookie and its CSRF token, mobile gets tokens in the body. */
export const loginResponseSchema = z.object({
  stage: sessionStageSchema,
  csrfToken: z.string().optional(),
  accessToken: z.string().optional(),
  accessTokenExpiresAt: isoInstant.optional(),
  refreshToken: z.string().optional(),
});

/** `POST /auth/staff/login`: what the account must do next, TOTP or its enrollment. */
export const staffLoginResponseSchema = loginResponseSchema.extend({
  next: z.enum(['totp', 'totp_enroll']),
});

/** `POST /auth/totp/enroll`. */
export const totpEnrollmentSchema = z.object({ secret: z.string(), otpauthUri: z.string() });

/** `POST /auth/refresh` (mobile). */
export const mobileTokensSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: isoInstant,
  refreshToken: z.string(),
});

/** `GET /auth/sessions`. */
export const sessionListSchema = z.array(
  z.object({
    id: z.uuid(),
    client: authClientSchema,
    deviceLabel: z.string().nullable(),
    createdAt: isoInstant,
    lastSeenAt: isoInstant,
    current: z.boolean(),
  }),
);

/** `POST /auth/logout-all`. */
export const logoutAllResponseSchema = z.object({ revoked: z.int().nonnegative() });
