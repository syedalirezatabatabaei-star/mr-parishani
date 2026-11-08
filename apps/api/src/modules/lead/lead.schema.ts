import {
  AGENT_PRESENCE,
  BLOCK_KINDS,
  CASE_STATUSES,
  INTAKE_CATEGORIES,
  INTAKE_CHANNELS,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
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
 * Persons, cases, intakes and their assignment (task 2-5b, doc 05, ADR-026). One Person per
 * human, never a second record; every request is a new Case on that Person, so the history
 * of every time stays. National IDs are stored only encrypted with a blind index (rule 27).
 */

export const persons = pgTable(
  'persons',
  {
    id: id(),
    displayName: text('display_name'),
    nationalIdEnc: text('national_id_enc'),
    nationalIdIndex: text('national_id_index'),
    nationalIdLast4: text('national_id_last4'),
    blockedKind: text('blocked_kind', { enum: BLOCK_KINDS }),
    blockedAt: timestamptz('blocked_at'),
    blockedReason: text('blocked_reason'),
    /** Set by a merge: this person lives on as that one (doc 05 §9). */
    mergedIntoId: uuid('merged_into_id'),
    /** When a user account was first linked to this person (PERSON_DIRECTORY). */
    accountLinkedAt: timestamptz('account_linked_at'),
    /** Recorded against an intake without consent, or an explicit opt-out (doc 05 §7). */
    smsOptedOutAt: timestamptz('sms_opted_out_at'),
    importBatchId: uuid('import_batch_id'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('persons_national_id_index_key')
      .on(t.nationalIdIndex)
      .where(sql`${t.deletedAt} IS NULL AND ${t.nationalIdIndex} IS NOT NULL`),
    index('persons_merged_into_id_idx').on(t.mergedIntoId),
  ],
);

/**
 * A person's mobiles, 9XXXXXXXXX; one mobile belongs to one person. Read only through
 * person-mobiles.ts (task 9-3, test/lead/person-mobiles-reads): a pending mobile gives
 * nothing of its Person and gets no SMS until approved.
 */
export const personMobiles = pgTable(
  'person_mobiles',
  {
    id: id(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    mobile: text('mobile').notNull(),
    /**
     * Task 9-3 (migration 0081): `pending` when added to a Person who already existed (a
     * national ID matched) or moved by a merge, until a proved mobile of that Person or
     * permitted staff approves; then `active`, or `rejected` (and soft-deleted). No default:
     * every insert says which. Only pending to active or rejected may change it (trigger).
     */
    status: text('status', { enum: ['active', 'pending', 'rejected'] }).notNull(),
    /** The first OTP login with this mobile: the proof that its holder has it. Set once. */
    provedAt: timestamptz('proved_at'),
    /**
     * Null on the rows before migration 0081. `merge`: re-issued pending by a merge or its
     * revert. `mobile_change`: the patient replaced their login mobile (ف۱۲, migration 0090).
     */
    addedVia: text('added_via', {
      enum: ['person_created', 'intake', 'import', 'credit_transfer', 'merge', 'mobile_change'],
    }),
    addedBy: uuid('added_by'),
    /** The import batch that added it pending: cancelling the batch refuses it. */
    importBatchId: uuid('import_batch_id'),
    /** A pending mobile's deadline, locked when it was added (`lead.person_mobile_pending_days`). */
    pendingExpiresAt: timestamptz('pending_expires_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('person_mobiles_mobile_key')
      .on(t.mobile)
      .where(sql`${t.deletedAt} IS NULL`),
    index('person_mobiles_person_id_idx').on(t.personId),
    index('person_mobiles_pending_idx')
      .on(t.pendingExpiresAt)
      .where(sql`${t.status} = 'pending' AND ${t.deletedAt} IS NULL`),
    check('person_mobiles_status_check', sql`${t.status} IN ('active', 'pending', 'rejected')`),
    check(
      'person_mobiles_rejected_deleted_check',
      sql`${t.status} <> 'rejected' OR ${t.deletedAt} IS NOT NULL`,
    ),
    check(
      'person_mobiles_added_via_check',
      sql`${t.addedVia} IN ('person_created', 'intake', 'import', 'credit_transfer', 'merge', 'mobile_change')`,
    ),
    check(
      'person_mobiles_pending_expires_check',
      sql`${t.status} <> 'pending' OR ${t.pendingExpiresAt} IS NOT NULL`,
    ),
  ],
);

/**
 * Each decision on a pending mobile (task 9-3, migration 0081): by a proved mobile of the
 * Person in their own panel, by permitted staff with evidence, or refused at the deadline.
 * Append-only.
 */
export const personMobileDecisions = pgTable(
  'person_mobile_decisions',
  {
    id: id(),
    personMobileId: uuid('person_mobile_id')
      .notNull()
      .references(() => personMobiles.id),
    decision: text('decision', { enum: ['approved', 'rejected'] }).notNull(),
    method: text('method', {
      enum: ['owner_panel', 'staff', 'expiry', 'import_cancelled'],
    }).notNull(),
    /** The account that decided; null at the deadline. */
    decidedBy: uuid('decided_by'),
    reason: text('reason').notNull(),
    /** Staff only: what proved the holder (e.g. the national card seen in person). */
    evidence: text('evidence'),
    /**
     * A staff approval's proposal (owner 1405/07/23, migration 0085): the first person
     * proposes, a second approves. Null on every other decision, and on the staff approvals
     * before 0085, which stay valid.
     */
    proposalId: uuid('proposal_id').references(() => personMobileProposals.id),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    index('person_mobile_decisions_mobile_idx').on(t.personMobileId),
    check('person_mobile_decisions_decision_check', sql`${t.decision} IN ('approved', 'rejected')`),
    check(
      'person_mobile_decisions_method_check',
      sql`${t.method} IN ('owner_panel', 'staff', 'expiry', 'import_cancelled')`,
    ),
    // NOT VALID in 0085: the staff approvals before it, by one person, stay as they are.
    check(
      'person_mobile_decisions_staff_proposal_check',
      sql`${t.method} <> 'staff' OR ${t.decision} <> 'approved' OR ${t.proposalId} IS NOT NULL`,
    ),
  ],
);

/**
 * The first of the two staff on a pending mobile (owner 1405/07/23, migration 0085): who
 * proposes approving it, with the evidence seen. One per mobile; a second holder of
 * lead.approve_person_mobile, neither the proposer nor who added the mobile, approves it
 * (a trigger on person_mobile_decisions refuses the proposer). Append-only.
 */
export const personMobileProposals = pgTable(
  'person_mobile_proposals',
  {
    id: id(),
    personMobileId: uuid('person_mobile_id')
      .notNull()
      .references(() => personMobiles.id),
    proposedBy: uuid('proposed_by').notNull(),
    reason: text('reason').notNull(),
    evidence: text('evidence').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('person_mobile_proposals_mobile_key').on(t.personMobileId)],
);

export const cases = pgTable(
  'cases',
  {
    id: id(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    status: text('status', { enum: CASE_STATUSES }).notNull().default('new'),
    queueCode: text('queue_code').notNull(),
    treatmentFieldCode: text('treatment_field_code').notNull(),
    cityCode: text('city_code'),
    channel: text('channel', { enum: INTAKE_CHANNELS }).notNull(),
    isReturning: boolean('is_returning').notNull().default(false),
    previousCaseId: uuid('previous_case_id'),
    /** The current assignee; the history is case_assignments. Null: unassigned. */
    assigneeAccountId: uuid('assignee_account_id'),
    abandonmentReasonCode: text('abandonment_reason_code'),
    abandonmentNote: text('abandonment_note'),
    closedAt: timestamptz('closed_at'),
    importBatchId: uuid('import_batch_id'),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [
    index('cases_person_id_idx').on(t.personId),
    index('cases_assignee_idx')
      .on(t.assigneeAccountId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index('cases_queue_idx').on(t.queueCode, t.status),
  ],
);

/** Every move of a case's status, with who and why. */
export const caseStatusChanges = pgTable(
  'case_status_changes',
  {
    id: id(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    fromStatus: text('from_status', { enum: CASE_STATUSES }),
    toStatus: text('to_status', { enum: CASE_STATUSES }).notNull(),
    reasonCode: text('reason_code'),
    note: text('note'),
    actorAccountId: uuid('actor_account_id'),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('case_status_changes_case_id_idx').on(t.caseId)],
);

/**
 * A case whose loans are all paid but which stands where it may not be completed from
 * (owner 1405/07/15: never passed on automatically, e.g. from new): left to staff, who see it
 * here. Append-only; open while its case is. One per case.
 */
export const caseCompletionAlerts = pgTable(
  'case_completion_alerts',
  {
    id: id(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    statusAtSettlement: text('status_at_settlement', { enum: CASE_STATUSES }).notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('case_completion_alerts_case_key').on(t.caseId)],
);

/** Every intake, duplicates and blocked ones included (doc 05 §4). */
export const caseIntakes = pgTable(
  'case_intakes',
  {
    id: id(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id),
    /** Null for a blocked person's intake: recorded, never assigned. */
    caseId: uuid('case_id').references(() => cases.id),
    category: text('category', { enum: INTAKE_CATEGORIES }).notNull(),
    channel: text('channel', { enum: INTAKE_CHANNELS }).notNull(),
    mobile: text('mobile').notNull(),
    name: text('name'),
    treatmentFieldCode: text('treatment_field_code').notNull(),
    cityCode: text('city_code'),
    smsConsent: boolean('sms_consent').notNull(),
    utm: jsonb('utm'),
    pageUrl: text('page_url'),
    /** Task 8-2: the page that sent the visitor to the WordPress form, if any. */
    referrer: text('referrer'),
    note: text('note'),
    importBatchId: uuid('import_batch_id'),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    index('case_intakes_person_id_idx').on(t.personId, t.createdAt),
    index('case_intakes_case_id_idx').on(t.caseId, t.createdAt),
  ],
);

/** Who has had a case, and how it got to them. The latest row is the current one. */
export const caseAssignments = pgTable(
  'case_assignments',
  {
    id: id(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => cases.id),
    /** Null: nobody could take it; it waits in `unassigned`. */
    accountId: uuid('account_id'),
    kind: text('kind', { enum: ['auto', 'returning', 'manual', 'unassigned'] }).notNull(),
    /** The shares an automatic assignment followed (task 2-5b decision 4). */
    weightVersionId: uuid('weight_version_id'),
    reason: text('reason'),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    index('case_assignments_case_id_idx').on(t.caseId, t.createdAt),
    index('case_assignments_version_idx').on(t.weightVersionId, t.accountId),
  ],
);

/** The abandonment reasons (doc 05 §5), edited from the panel. */
export const abandonmentReasons = pgTable(
  'abandonment_reasons',
  {
    id: id(),
    code: text('code').notNull(),
    title: text('title').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: uuid('created_by'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('abandonment_reasons_code_key').on(t.code)],
);

/**
 * The shares of one queue, and optionally one city and treatment field, from a moment on
 * (doc 05 §6). Append-only: a change is a new version, and the counting starts over.
 */
export const assignmentWeightVersions = pgTable(
  'assignment_weight_versions',
  {
    id: id(),
    queueCode: text('queue_code').notNull(),
    cityCode: text('city_code'),
    treatmentFieldCode: text('treatment_field_code'),
    effectiveAt: timestamptz('effective_at').notNull().defaultNow(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    index('assignment_weight_versions_key_idx').on(
      t.queueCode,
      t.cityCode,
      t.treatmentFieldCode,
      t.effectiveAt,
    ),
  ],
);

export const assignmentWeights = pgTable(
  'assignment_weights',
  {
    id: id(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => assignmentWeightVersions.id),
    accountId: uuid('account_id').notNull(),
    percent: integer('percent').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('assignment_weights_key').on(t.versionId, t.accountId)],
);

/**
 * The running credit of each agent under one version (smooth weighted round-robin):
 * working state, not history, and changed only under the version's lock.
 */
export const assignmentRrState = pgTable(
  'assignment_rr_state',
  {
    id: id(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => assignmentWeightVersions.id),
    accountId: uuid('account_id').notNull(),
    currentWeight: integer('current_weight').notNull().default(0),
    ...timestamps(),
  },
  (t) => [uniqueIndex('assignment_rr_state_key').on(t.versionId, t.accountId)],
);

/** An agent's presence; the latest row is in force. */
export const agentPresence = pgTable(
  'agent_presence',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    status: text('status', { enum: AGENT_PRESENCE }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('agent_presence_account_idx').on(t.accountId, t.createdAt)],
);

/** An agent's cap on open cases; the latest row is in force; null: none. */
export const agentCaps = pgTable(
  'agent_caps',
  {
    id: id(),
    accountId: uuid('account_id').notNull(),
    maxOpenCases: integer('max_open_cases'),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('agent_caps_account_idx').on(t.accountId, t.createdAt)],
);

/** A merge of two persons and exactly what it moved, so that it can be reverted. */
export const personMerges = pgTable(
  'person_merges',
  {
    id: id(),
    survivorId: uuid('survivor_id')
      .notNull()
      .references(() => persons.id),
    mergedId: uuid('merged_id')
      .notNull()
      .references(() => persons.id),
    movedCaseIds: uuid('moved_case_ids').array().notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by'),
    revertedAt: timestamptz('reverted_at'),
    revertedBy: uuid('reverted_by'),
    revertReason: text('revert_reason'),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('person_merges_merged_id_idx').on(t.mergedId)],
);

/** One upload of the import sheet (doc 05 §8); the file itself is never kept. */
export const leadImportBatches = pgTable('lead_import_batches', {
  id: id(),
  status: text('status', {
    enum: ['previewed', 'committed', 'processed', 'cancelled'],
  }).notNull(),
  fileName: text('file_name').notNull(),
  rowCount: integer('row_count').notNull(),
  validCount: integer('valid_count').notNull(),
  errorCount: integer('error_count').notNull(),
  createdBy: uuid('created_by'),
  committedAt: timestamptz('committed_at'),
  committedBy: uuid('committed_by'),
  processedAt: timestamptz('processed_at'),
  cancelledAt: timestamptz('cancelled_at'),
  cancelledBy: uuid('cancelled_by'),
  cancelReason: text('cancel_reason'),
  ...timestamps(),
});

/** One row of an upload, normalized; a national ID only encrypted. */
export const leadImportRows = pgTable(
  'lead_import_rows',
  {
    id: id(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => leadImportBatches.id),
    rowNumber: integer('row_number').notNull(),
    status: text('status', {
      enum: ['valid', 'error', 'processed', 'failed', 'cancelled'],
    }).notNull(),
    /** Error codes of the row (never the values). */
    errors: text('errors').array().notNull(),
    mobile: text('mobile'),
    name: text('name'),
    nationalIdEnc: text('national_id_enc'),
    treatmentFieldCode: text('treatment_field_code'),
    cityCode: text('city_code'),
    smsConsent: boolean('sms_consent').notNull().default(false),
    intakeId: uuid('intake_id'),
    caseId: uuid('case_id'),
    personId: uuid('person_id'),
    /** The person did not exist before this row. */
    createdPerson: boolean('created_person').notNull().default(false),
    processedAt: timestamptz('processed_at'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('lead_import_rows_key').on(t.batchId, t.rowNumber)],
);

/** Each delivery of the WordPress form, by its idempotency key (doc 05 §7). */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    source: text('source').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status', { enum: ['accepted', 'dropped'] }).notNull(),
    intakeId: uuid('intake_id'),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('webhook_deliveries_key').on(t.source, t.idempotencyKey)],
);

/**
 * ADR-048 (owner 1405/07/30, answer 2): a customer-club membership, recorded by a club officer
 * with its first day, its last day (none: open), who recorded it and why. Append-only: a
 * membership ended early gets a revocation row, never an edit.
 */
export const clubMemberships = pgTable(
  'club_memberships',
  {
    id: id(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'restrict' }),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    /** The last day of membership, inclusive; null while open. */
    endsOn: date('ends_on', { mode: 'string' }),
    recordedBy: uuid('recorded_by').notNull(),
    reason: text('reason').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    index('club_memberships_person_idx').on(t.personId, t.startsOn),
    check('club_memberships_dates_check', sql`${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`),
    check('club_memberships_reason_check', sql`length(trim(${t.reason})) >= 3`),
  ],
);

/** A membership ended early: from `revoked_on` on, it no longer counts. Once per membership. */
export const clubMembershipRevocations = pgTable(
  'club_membership_revocations',
  {
    id: id(),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => clubMemberships.id, { onDelete: 'restrict' }),
    /** The first day it no longer counts. */
    revokedOn: date('revoked_on', { mode: 'string' }).notNull(),
    recordedBy: uuid('recorded_by').notNull(),
    reason: text('reason').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('club_membership_revocations_membership_key').on(t.membershipId),
    check('club_membership_revocations_reason_check', sql`length(trim(${t.reason})) >= 3`),
  ],
);
