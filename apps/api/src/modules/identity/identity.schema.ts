import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appendOnlyTimestamps, id, timestamps, timestamptz } from '../../db/columns';

/**
 * A login identity. Patients log in by OTP on their mobile; staff and center users by
 * password + TOTP. Credentials live here (null for patients) so there is one table to
 * disable or audit.
 */
export const userAccounts = pgTable(
  'user_accounts',
  {
    id: id(),
    kind: text('kind', { enum: ['patient', 'staff', 'center'] }).notNull(),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    /** Normalized 9XXXXXXXXX; the login key of a patient. */
    mobile: text('mobile'),
    /**
     * When a staff or center user proved `mobile` with a code sent to it (task 4-6, owner:
     * verified by OTP, never only typed). Null: not verified. A patient's mobile is proved
     * by logging in.
     */
    mobileVerifiedAt: timestamptz('mobile_verified_at'),
    /** Lowercase; the login key of staff and center users. */
    username: text('username'),
    displayName: text('display_name'),
    /** The one Person of this patient (doc 05), set through the PersonDirectory port. */
    personId: uuid('person_id'),
    passwordHash: text('password_hash'),
    /** TOTP secret, encrypted with FieldCrypto (rule 27). */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpConfirmedAt: timestamptz('totp_confirmed_at'),
    /** Last accepted TOTP time step; a code is never accepted twice. */
    totpLastStep: integer('totp_last_step'),
    ...timestamps(),
  },
  (t) => [
    // Both keys skip soft-deleted rows, so that they agree with every lookup in the
    // service, which filters `deleted_at IS NULL` (rule 7): a mobile or username freed by
    // a soft delete can be used again.
    uniqueIndex('user_accounts_patient_mobile_key')
      .on(t.mobile)
      .where(sql`${t.kind} = 'patient' AND ${t.deletedAt} IS NULL`),
    uniqueIndex('user_accounts_username_key')
      .on(t.username)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * A logged-in device. Web sessions are carried by the `__Host-sid` cookie, mobile ones by
 * a short-lived access token; either way only its SHA-256 hash is stored. Logging out
 * sets revoked_at; rows are never deleted.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => userAccounts.id),
    client: text('client', { enum: ['web', 'mobile'] }).notNull(),
    /** `mfa_pending`: password verified, TOTP not yet; can only reach TOTP endpoints. */
    stage: text('stage', { enum: ['mfa_pending', 'active'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenExpiresAt: timestamptz('token_expires_at').notNull(),
    deviceId: text('device_id'),
    deviceLabel: text('device_label'),
    ip: text('ip'),
    authenticatedAt: timestamptz('authenticated_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    revokedAt: timestamptz('revoked_at'),
    revokeReason: text('revoke_reason'),
    /**
     * Task 9-3 (R1): when this session last gave a TOTP code again, for sensitive actions.
     * This session's only; null after a password change.
     */
    reauthenticatedAt: timestamptz('reauthenticated_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_account_id_idx').on(t.accountId),
  ],
);

/**
 * Mobile refresh tokens, one-time use. Using one issues its successor; presenting a used
 * one again revokes the whole session (reuse detection).
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: id(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id),
    tokenHash: text('token_hash').notNull(),
    parentId: uuid('parent_id'),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_token_hash_key').on(t.tokenHash),
    index('refresh_tokens_session_id_idx').on(t.sessionId),
  ],
);

/**
 * Resetting a staff member's TOTP needs two different people (maker-checker, doc 04 §5):
 * otherwise a system administrator could take over any account.
 */
export const totpResetRequests = pgTable(
  'totp_reset_requests',
  {
    id: id(),
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => userAccounts.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => userAccounts.id),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired'] })
      .notNull()
      .default('pending'),
    decidedBy: uuid('decided_by').references(() => userAccounts.id),
    decidedAt: timestamptz('decided_at'),
    ...timestamps(),
  },
  (t) => [index('totp_reset_requests_target_idx').on(t.targetAccountId)],
);

/**
 * Offboarding a staff or center account (owner 1405/07/23, plan 4; migration 0087): one
 * person asks, with a reason; a different one, never the target, approves or rejects
 * (maker-checker, as totp_reset_requests). Approving disables the account, revokes every role
 * and ends every session. At most one open request per account.
 */
export const staffOffboardingRequests = pgTable(
  'staff_offboarding_requests',
  {
    id: id(),
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => userAccounts.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => userAccounts.id),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    decidedBy: uuid('decided_by').references(() => userAccounts.id),
    decidedAt: timestamptz('decided_at'),
    /** Approved: how many role assignments it revoked. */
    rolesRevoked: integer('roles_revoked'),
    ...timestamps(),
  },
  (t) => [
    index('staff_offboarding_requests_target_idx').on(t.targetAccountId),
    uniqueIndex('staff_offboarding_requests_open_key')
      .on(t.targetAccountId)
      .where(sql`${t.status} = 'pending'`),
    check(
      'staff_offboarding_requests_status_check',
      sql`${t.status} IN ('pending', 'approved', 'rejected')`,
    ),
    check('staff_offboarding_requests_reason_check', sql`length(trim(${t.reason})) >= 3`),
    check(
      'staff_offboarding_requests_two_people_check',
      sql`${t.requestedBy} <> ${t.targetAccountId} AND (${t.decidedBy} IS NULL OR (${t.decidedBy} <> ${t.requestedBy} AND ${t.decidedBy} <> ${t.targetAccountId}))`,
    ),
    check(
      'staff_offboarding_requests_decided_check',
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL)`,
    ),
  ],
);

/**
 * ف۱۲ ب۲ (owner 1405/07/26; migration 0091): a patient whose previous mobile is lost has staff
 * replace it, by two people as 0085. The first holder of identity.change_patient_mobile
 * proposes, with the evidence seen and the code sent to the new mobile; a second, never the
 * first, approves (the database holds it too, ..._two_people_check); refusing takes one. At
 * most one open request per account and per new mobile. The whole numbers stay in this row,
 * like user_accounts.mobile; answers and the audit carry the last four digits only (rule 30).
 */
export const patientMobileChangeRequests = pgTable(
  'patient_mobile_change_requests',
  {
    id: id(),
    targetAccountId: uuid('target_account_id')
      .notNull()
      .references(() => userAccounts.id),
    /** The login mobile when proposed, 9XXXXXXXXX: approving checks it has not changed since. */
    fromMobile: text('from_mobile').notNull(),
    /** The new mobile, proved by its code when proposed. */
    toMobile: text('to_mobile').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => userAccounts.id),
    reason: text('reason').notNull(),
    evidence: text('evidence').notNull(),
    // expired: not decided within staffRequestDays (owner 1405/07/27, migration 0092).
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired'] })
      .notNull()
      .default('pending'),
    decidedBy: uuid('decided_by').references(() => userAccounts.id),
    decidedAt: timestamptz('decided_at'),
    decisionReason: text('decision_reason'),
    /** Approved: how many of the patient's sessions it ended. */
    sessionsEnded: integer('sessions_ended'),
    ...timestamps(),
  },
  (t) => [
    index('patient_mobile_change_requests_target_idx').on(t.targetAccountId),
    uniqueIndex('patient_mobile_change_requests_open_key')
      .on(t.targetAccountId)
      .where(sql`${t.status} = 'pending'`),
    uniqueIndex('patient_mobile_change_requests_open_to_key')
      .on(t.toMobile)
      .where(sql`${t.status} = 'pending'`),
    check(
      'patient_mobile_change_requests_status_check',
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'expired')`,
    ),
    check(
      'patient_mobile_change_requests_mobiles_check',
      sql`${t.fromMobile} ~ '^9[0-9]{9}$' AND ${t.toMobile} ~ '^9[0-9]{9}$' AND ${t.fromMobile} <> ${t.toMobile}`,
    ),
    check(
      'patient_mobile_change_requests_text_check',
      sql`length(trim(${t.reason})) >= 3 AND length(trim(${t.evidence})) >= 3`,
    ),
    check(
      'patient_mobile_change_requests_two_people_check',
      sql`${t.requestedBy} <> ${t.targetAccountId} AND (${t.decidedBy} IS NULL OR ${t.decidedBy} <> ${t.targetAccountId}) AND (${t.status} <> 'approved' OR ${t.decidedBy} <> ${t.requestedBy})`,
    ),
    check(
      'patient_mobile_change_requests_decided_check',
      sql`(${t.status} = 'pending') = (${t.decidedBy} IS NULL AND ${t.decidedAt} IS NULL AND ${t.decisionReason} IS NULL)`,
    ),
  ],
);

/**
 * Each run of `pnpm lead:backfill-persons` (task 2-5b decision 1): linking the patient
 * accounts made before the lead module to their Person. A dry run records what it would
 * do. `manual_review` lists account ids and why, never a mobile (rule 30).
 */
export const personBackfillRuns = pgTable('person_backfill_runs', {
  id: id(),
  mode: text('mode', { enum: ['dry_run', 'apply'] }).notNull(),
  /** Patient accounts without a person when the run started. */
  candidates: integer('candidates').notNull(),
  /** Linked (apply), or that would be (dry run). */
  filled: integer('filled').notNull(),
  manualReview: jsonb('manual_review').notNull(),
  startedAt: timestamptz('started_at').notNull(),
  finishedAt: timestamptz('finished_at').notNull(),
  ...appendOnlyTimestamps(),
});

/**
 * The login factor changes an account is told of by SMS (task 9-3, R2). Not exported: a
 * schema module exports tables only (test/db/conventions).
 */
const FACTOR_CHANGE_EVENTS = [
  'password_changed',
  'totp_reset',
  'totp_enrolled',
  'mobile_changed',
  'patient_mobile_changed',
  // A mobile added to the patient's Person, then approved or refused (task 9-3, migration 0081).
  'patient_mobile_added',
  'patient_mobile_approved',
  'patient_mobile_rejected',
] as const;
export type FactorChangeEvent = (typeof FACTOR_CHANGE_EVENTS)[number];

/**
 * One SMS owed for a login factor change (task 9-3, R2), written in the change's own
 * transaction with its outbox event; the consumer sends it after the commit. Holds the
 * recipient as it was then (a changed mobile's notice goes to the previous one), so the event
 * itself carries no mobile (rule 30). Append-only.
 */
export const factorChangeNotices = pgTable(
  'factor_change_notices',
  {
    id: id(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => userAccounts.id),
    event: text('event', { enum: FACTOR_CHANGE_EVENTS }).notNull(),
    audience: text('audience', { enum: ['staff', 'patient'] }).notNull(),
    /** Normalized 9XXXXXXXXX. */
    mobile: text('mobile').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    index('factor_change_notices_account_idx').on(t.accountId),
    check(
      'factor_change_notices_event_check',
      sql`${t.event} IN ('password_changed', 'totp_reset', 'totp_enrolled', 'mobile_changed', 'patient_mobile_changed', 'patient_mobile_added', 'patient_mobile_approved', 'patient_mobile_rejected')`,
    ),
    check('factor_change_notices_audience_check', sql`${t.audience} IN ('staff', 'patient')`),
    check('factor_change_notices_mobile_check', sql`${t.mobile} ~ '^9[0-9]{9}$'`),
  ],
);
