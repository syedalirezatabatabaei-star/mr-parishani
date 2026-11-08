import { CREDIT_APPLICATION_STATUSES } from '@sepehr/contracts';
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
import { appendOnlyTimestamps, id, rial, timestamps, timestamptz } from '../../db/columns';

/**
 * Credit applications (task 3-5, doc 10 §4). The case, proforma and persons belong to
 * other modules, so they are ids here (module boundary). The plan and its preview are a
 * snapshot locked to the configuration versions of the day it was chosen (rule 16); only
 * the state and its timestamps change afterwards (migration 0024 enforces it).
 */
export const creditApplications = pgTable(
  'credit_applications',
  {
    id: id(),
    caseId: uuid('case_id').notNull(),
    proformaId: uuid('proforma_id').notNull(),
    patientPersonId: uuid('patient_person_id').notNull(),
    borrowerPersonId: uuid('borrower_person_id').notNull(),
    /** The account that made it (the patient). */
    createdBy: uuid('created_by').notNull(),
    status: text('status', { enum: CREDIT_APPLICATION_STATUSES }).notNull().default('draft'),
    // The plan chosen and the configuration it was read from (CreditPlanService.quote).
    planCode: text('plan_code').notNull(),
    planTitle: text('plan_title').notNull(),
    plansVersionId: uuid('plans_version_id').notNull(),
    roundingVersionId: uuid('rounding_version_id').notNull(),
    reductionVersionId: uuid('reduction_version_id').notNull(),
    // ADR-041 (migration 0084): the schedule's due-day shift and grace days, locked here too.
    shiftVersionId: uuid('shift_version_id').notNull(),
    graceVersionId: uuid('grace_version_id').notNull(),
    installmentCount: integer('installment_count').notNull(),
    // The preview at that moment (doc 10 §3); due dates are recomputed from funding later.
    proformaTotalRial: rial('proforma_total_rial').notNull(),
    downPaymentRial: rial('down_payment_rial').notNull(),
    loanRial: rial('loan_rial').notNull(),
    cashTopUpRial: rial('cash_top_up_rial').notNull(),
    planFeeRial: rial('plan_fee_rial').notNull(),
    planFeeTiming: text('plan_fee_timing', { enum: ['at_completion', 'spread'] }).notNull(),
    originationFeeRial: rial('origination_fee_rial').notNull(),
    totalObligationRial: rial('total_obligation_rial').notNull(),
    /** ADR-048: the patient's club membership on the day it was made, for a club plan only. */
    clubMembershipId: uuid('club_membership_id'),
    /** ADR-050: the proforma's wage lines (W), locked for a wage-only plan; else null. */
    wageRial: rial('wage_rial'),
    /** ADR-050: the materials (T − W), part of the cash to the doctor; 0 for any other plan. */
    materialCashRial: rial('material_cash_rial')
      .notNull()
      .default(sql`0`),
    /** The document checklist version, locked when the application is submitted. */
    checklistVersionId: uuid('checklist_version_id'),
    /** The scoring rules version, locked by the first score sheet (doc 03 §8-3). */
    rulesetVersionId: uuid('ruleset_version_id'),
    /** The borrower's grade from the latest sheet; guarantors wait for it (doc 03 §1). */
    borrowerGrade: text('borrower_grade'),
    amountLevel: text('amount_level'),
    /** «Needs more guarantors» is a label on `incomplete`, not a status (doc 10 §4). */
    needsMoreGuarantors: boolean('needs_more_guarantors').notNull().default(false),
    submittedAt: timestamptz('submitted_at'),
    // The decision (task 3-6, doc 10 §6). Who decides is the engine's, never a person's:
    // locked on entering manual_review and recomputed only by the engine when the approved
    // amount is reduced (doc 03 §4). Once decided, nothing of it changes (migration 0028).
    decisionAuthority: text('decision_authority'),
    guaranteeRequirement: text('guarantee_requirement'),
    sufficiency: text('sufficiency'),
    approvedAmountRial: rial('approved_amount_rial'),
    decision: text('decision', { enum: ['approved', 'conditional', 'rejected'] }),
    conditions: jsonb('conditions').$type<string[]>(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    /**
     * Applications that finance one treatment together (doc 10 §7; task 3-7): two
     * borrowers over the cap, or a new case for a large shortfall. In a group,
     * `proforma_total_rial` is this application's share of the proforma, and its down
     * payment and fees are its own, on that share (owner, 1405/07/10).
     */
    caseGroupId: uuid('case_group_id'),
    /** What the approved amount leaves to pay in cash, and whether it is a small shortfall. */
    approvedCashTopUpRial: rial('approved_cash_top_up_rial'),
    shortfallKind: text('shortfall_kind', { enum: ['none', 'small', 'large'] }),
    /** Set on entering ready_for_review: + credit.sla_hours. */
    slaDueAt: timestamptz('sla_due_at'),
    slaBreachedAt: timestamptz('sla_breached_at'),
    ...timestamps(),
  },
  (t) => [
    // One open application per proforma, borrower and case; a rejected or expired one
    // leaves room. Two borrowers of one case (over the cap), or a new case of the same
    // person (a large shortfall), share a proforma in a group (task 3-7, owner 1405/07/10).
    uniqueIndex('credit_applications_open_borrower_key')
      .on(t.proformaId, t.borrowerPersonId, t.caseId)
      .where(sql`${t.status} NOT IN ('rejected', 'expired') AND ${t.deletedAt} IS NULL`),
    index('credit_applications_group_idx').on(t.caseGroupId),
    index('credit_applications_case_idx').on(t.caseId),
    index('credit_applications_borrower_idx').on(t.borrowerPersonId),
    index('credit_applications_patient_idx').on(t.patientPersonId),
    index('credit_applications_status_idx').on(t.status, t.slaDueAt),
    check('credit_applications_count_check', sql`${t.installmentCount} BETWEEN 1 AND 360`),
    check(
      'credit_applications_amounts_check',
      sql`${t.proformaTotalRial} > 0 AND ${t.downPaymentRial} >= 0 AND ${t.loanRial} > 0
          AND ${t.cashTopUpRial} >= 0 AND ${t.planFeeRial} >= 0 AND ${t.originationFeeRial} >= 0
          AND ${t.downPaymentRial} + ${t.loanRial} + ${t.cashTopUpRial} = ${t.proformaTotalRial}
          AND ${t.totalObligationRial} >= ${t.loanRial}`,
    ),
    check(
      'credit_applications_material_cash_check',
      sql`${t.materialCashRial} >= 0 AND ${t.materialCashRial} <= ${t.cashTopUpRial}
          AND (${t.wageRial} IS NULL OR (${t.wageRial} >= 0 AND ${t.wageRial} <= ${t.proformaTotalRial}
               AND ${t.materialCashRial} = ${t.proformaTotalRial} - ${t.wageRial}))
          AND (${t.wageRial} IS NOT NULL OR ${t.materialCashRial} = 0)`,
    ),
    check(
      'credit_applications_approved_amount_check',
      sql`${t.approvedAmountRial} IS NULL OR (${t.approvedAmountRial} > 0 AND ${t.approvedAmountRial} <= ${t.loanRial})`,
    ),
  ],
);

/** Every move of an application's state, append-only. */
export const creditApplicationStatusChanges = pgTable(
  'credit_application_status_changes',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorAccountId: uuid('actor_account_id'),
    note: text('note'),
    ...appendOnlyTimestamps(),
  },
  (t) => [index('credit_application_status_changes_app_idx').on(t.creditApplicationId)],
);

/**
 * Consent to the credit check (doc 03 §8-6, doc 10 §4), given by the person themselves
 * with a one-time code, to the text version in force. Append-only.
 */
export const creditConsents = pgTable(
  'credit_consents',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id),
    personId: uuid('person_id').notNull(),
    role: text('role', { enum: ['borrower', 'guarantor'] }).notNull(),
    consentTextVersionId: uuid('consent_text_version_id').notNull(),
    accountId: uuid('account_id').notNull(),
    sessionId: uuid('session_id'),
    ip: text('ip'),
    deviceId: text('device_id'),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('credit_consents_person_key').on(t.creditApplicationId, t.personId, t.role)],
);

/** A guarantor of an application (doc 10 §5): a person with a role in it. */
export const creditGuarantors = pgTable(
  'credit_guarantors',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id),
    personId: uuid('person_id').notNull(),
    status: text('status', { enum: ['invited', 'consented', 'scored', 'withdrawn'] })
      .notNull()
      .default('invited'),
    invitedBy: uuid('invited_by').notNull(),
    consentAt: timestamptz('consent_at'),
    grade: text('grade'),
    weight: integer('weight'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('credit_guarantors_person_key')
      .on(t.creditApplicationId, t.personId)
      .where(sql`${t.status} <> 'withdrawn'`),
    index('credit_guarantors_person_idx').on(t.personId),
    check(
      'credit_guarantors_weight_check',
      sql`${t.weight} IS NULL OR ${t.weight} BETWEEN 0 AND 3`,
    ),
  ],
);

/**
 * A score sheet (doc 10 §5): the raw data entered, the options the engine chose, the
 * score of each criterion, the total and the grade, under the locked rules version. A new
 * sheet for the same person supersedes the last; nothing is ever deleted.
 */
export const scoreSheets = pgTable(
  'score_sheets',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id),
    subject: text('subject', { enum: ['borrower', 'guarantor'] }).notNull(),
    personId: uuid('person_id').notNull(),
    guarantorId: uuid('guarantor_id').references(() => creditGuarantors.id),
    rulesetVersionId: uuid('ruleset_version_id').notNull(),
    rawInputs: jsonb('raw_inputs').notNull(),
    answers: jsonb('answers').notNull(),
    criteriaScores: jsonb('criteria_scores').notNull(),
    total: integer('total'),
    grade: text('grade'),
    stop: boolean('stop'),
    computedBy: uuid('computed_by').notNull(),
    supersededBy: uuid('superseded_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    index('score_sheets_application_idx').on(t.creditApplicationId, t.subject),
    uniqueIndex('score_sheets_current_key')
      .on(t.creditApplicationId, t.personId, t.subject)
      .where(sql`${t.supersededBy} IS NULL`),
    check(
      'score_sheets_subject_check',
      sql`(${t.subject} = 'guarantor') = (${t.guarantorId} IS NOT NULL)`,
    ),
  ],
);

/**
 * A document of a credit application (doc 10 §4): one upload of one checklist item by
 * its person. The file lives in private storage under a generated key; only its state
 * and decision change. A new upload of the same item supersedes a submitted one.
 */
export const creditDocuments = pgTable(
  'credit_documents',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id),
    personId: uuid('person_id').notNull(),
    role: text('role', { enum: ['borrower', 'guarantor'] }).notNull(),
    guarantorId: uuid('guarantor_id').references(() => creditGuarantors.id),
    itemCode: text('item_code').notNull(),
    checklistVersionId: uuid('checklist_version_id').notNull(),
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status', { enum: ['submitted', 'accepted', 'rejected', 'superseded'] })
      .notNull()
      .default('submitted'),
    reason: text('reason'),
    uploadedBy: uuid('uploaded_by').notNull(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamptz('decided_at'),
    ...timestamps(),
  },
  (t) => [
    index('credit_documents_application_idx').on(t.creditApplicationId),
    uniqueIndex('credit_documents_current_key')
      .on(t.creditApplicationId, t.personId, t.role, t.itemCode)
      .where(sql`${t.status} IN ('submitted', 'accepted')`),
    uniqueIndex('credit_documents_storage_key').on(t.storageKey),
    check('credit_documents_size_check', sql`${t.sizeBytes} > 0`),
    check(
      'credit_documents_role_check',
      sql`(${t.role} = 'guarantor') = (${t.guarantorId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Who works an application in each credit queue (doc 10 §8): chosen by the lead module's
 * engine (doc 05 §6), or by hand with a reason. Append-only; the latest row of a queue is
 * its current assignee.
 */
export const creditApplicationAssignments = pgTable(
  'credit_application_assignments',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id),
    queueCode: text('queue_code', { enum: ['completion', 'credit', 'committee'] }).notNull(),
    accountId: uuid('account_id'),
    kind: text('kind', { enum: ['auto', 'manual', 'unassigned'] }).notNull(),
    weightVersionId: uuid('weight_version_id'),
    reason: text('reason'),
    createdBy: uuid('created_by'),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    index('credit_application_assignments_app_idx').on(t.creditApplicationId, t.queueCode),
    index('credit_application_assignments_account_idx').on(t.accountId, t.queueCode),
    check(
      'credit_application_assignments_kind_check',
      sql`(${t.kind} = 'unassigned') = (${t.accountId} IS NULL)
          AND (${t.kind} <> 'manual' OR ${t.reason} IS NOT NULL)
          AND (${t.kind} <> 'auto' OR ${t.weightVersionId} IS NOT NULL)`,
    ),
  ],
);

/**
 * A decision on a credit application (task 3-6, doc 10 §6): proposed with a reason, and
 * final once the authority the engine named has confirmed it: a second person, the credit
 * manager, or the committee (at least two of three units). Out of the matrix it needs a
 * second approver and the committee both. Its content never changes; only its state does.
 */
export const creditDecisions = pgTable(
  'credit_decisions',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id),
    outcome: text('outcome', {
      enum: ['approved', 'conditional', 'rejected', 'needs_more_guarantors'],
    }).notNull(),
    status: text('status', { enum: ['proposed', 'decided', 'refused', 'withdrawn'] })
      .notNull()
      .default('proposed'),
    /** Who must confirm it, from the engine at the moment it was proposed. */
    authority: text('authority').notNull(),
    rulesetVersionId: uuid('ruleset_version_id').notNull(),
    outOfMatrix: boolean('out_of_matrix').notNull().default(false),
    approvedAmountRial: rial('approved_amount_rial'),
    amountLevel: text('amount_level'),
    /** The preview of the approved amount, made with the application's locked versions. */
    quote: jsonb('quote'),
    conditions: jsonb('conditions').$type<string[]>(),
    /** What is missing, for needs_more_guarantors. */
    missing: jsonb('missing').$type<string[]>(),
    reasonCode: text('reason_code'),
    reason: text('reason').notNull(),
    // The committee's minutes, when the committee decides.
    minutesNumber: text('minutes_number'),
    meetingAt: timestamptz('meeting_at'),
    attendeeAccountIds: uuid('attendee_account_ids').array(),
    proposedBy: uuid('proposed_by').notNull(),
    /** The second check, the manager, or (out of the matrix) the second approver. */
    checkedBy: uuid('checked_by'),
    checkedAt: timestamptz('checked_at'),
    closedBy: uuid('closed_by'),
    closeReason: text('close_reason'),
    closedAt: timestamptz('closed_at'),
    ...timestamps(),
  },
  (t) => [
    index('credit_decisions_application_idx').on(t.creditApplicationId),
    uniqueIndex('credit_decisions_open_key')
      .on(t.creditApplicationId)
      .where(sql`${t.status} = 'proposed'`),
    check('credit_decisions_reason_check', sql`length(btrim(${t.reason})) > 0`),
    check(
      'credit_decisions_amount_check',
      sql`(${t.outcome} IN ('approved', 'conditional')) = (${t.approvedAmountRial} IS NOT NULL)
          AND (${t.approvedAmountRial} IS NULL OR ${t.approvedAmountRial} > 0)`,
    ),
  ],
);

/** A committee member's vote on a decision, for their unit (doc 03 §6). Append-only. */
export const creditCommitteeVotes = pgTable(
  'credit_committee_votes',
  {
    id: id(),
    creditDecisionId: uuid('credit_decision_id')
      .notNull()
      .references(() => creditDecisions.id),
    accountId: uuid('account_id').notNull(),
    unitCode: text('unit_code').notNull(),
    vote: text('vote', { enum: ['approve', 'object'] }).notNull(),
    note: text('note'),
    ...appendOnlyTimestamps(),
  },
  (t) => [uniqueIndex('credit_committee_votes_member_key').on(t.creditDecisionId, t.accountId)],
);

/**
 * A condition of a conditional approval, ticked as met (task 4-3; doc 12 §4 item 3): by
 * whom and when; the condition's text as decided. Append-only; once per condition.
 */
export const creditConditionChecks = pgTable(
  'credit_condition_checks',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id),
    conditionIndex: integer('condition_index').notNull(),
    conditionText: text('condition_text').notNull(),
    checkedBy: uuid('checked_by').notNull(),
    note: text('note'),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('credit_condition_checks_condition_key').on(
      t.creditApplicationId,
      t.conditionIndex,
    ),
    check('credit_condition_checks_index_check', sql`${t.conditionIndex} >= 0`),
  ],
);

/**
 * A formation deposit's details (owner 1405/07/29, answer f; migration 0100). The pilot records
 * them only: no ledger row, no purse; the `deposit.held` account comes after the pilot with its
 * own ADR. The amount and its configuration version are locked here (rule 16); one per
 * application. Only the refund columns are ever set afterwards, once (a trigger guards it), and
 * only before the introduction letter (the service: the purse's charge, its default).
 */
export const creditFormationDeposits = pgTable(
  'credit_formation_deposits',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id, { onDelete: 'restrict' }),
    amountRial: rial('amount_rial').notNull(),
    configVersionId: uuid('config_version_id').notNull(),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    bankReference: text('bank_reference').notNull(),
    note: text('note'),
    recordedBy: uuid('recorded_by').notNull(),
    refundedOn: date('refunded_on', { mode: 'string' }),
    refundReference: text('refund_reference'),
    refundReason: text('refund_reason'),
    refundedBy: uuid('refunded_by'),
    refundedAt: timestamptz('refunded_at'),
    ...timestamps(),
  },
  (t) => [
    check('credit_formation_deposits_amount_check', sql`${t.amountRial} > 0`),
    check(
      'credit_formation_deposits_reference_check',
      sql`length(trim(${t.bankReference})) BETWEEN 3 AND 60`,
    ),
    check(
      'credit_formation_deposits_refund_check',
      sql`(${t.refundedOn} IS NULL AND ${t.refundReference} IS NULL AND ${t.refundReason} IS NULL
           AND ${t.refundedBy} IS NULL AND ${t.refundedAt} IS NULL)
          OR (${t.refundedOn} IS NOT NULL AND ${t.refundReference} IS NOT NULL
           AND ${t.refundReason} IS NOT NULL AND ${t.refundedBy} IS NOT NULL
           AND ${t.refundedAt} IS NOT NULL AND ${t.refundedOn} >= ${t.paidOn}
           AND length(trim(${t.refundReason})) >= 3
           AND length(trim(${t.refundReference})) BETWEEN 3 AND 60)`,
    ),
    uniqueIndex('credit_formation_deposits_application_key')
      .on(t.creditApplicationId)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/**
 * ADR-050: credit or case completion checked a wage-only application's split of wage and
 * materials, once, with a note; the decision waits for it. Append-only.
 */
export const creditCostSplitReviews = pgTable(
  'credit_cost_split_reviews',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id, { onDelete: 'restrict' }),
    reviewedBy: uuid('reviewed_by').notNull(),
    note: text('note').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    uniqueIndex('credit_cost_split_reviews_application_key').on(t.creditApplicationId),
    check('credit_cost_split_reviews_note_check', sql`length(trim(${t.note})) >= 3`),
  ],
);

/**
 * ADR-051: each check of the borrower's cap (ج۶), at the decision or the funding: what was owed
 * then without this loan, its amount, the cap, the basis, the configuration version, and whether
 * it passed. A pass is written in the step's own transaction; a refusal in one of its own after
 * that has rolled back. Append-only.
 */
export const creditExposureChecks = pgTable(
  'credit_exposure_checks',
  {
    id: id(),
    creditApplicationId: uuid('credit_application_id')
      .notNull()
      .references(() => creditApplications.id, { onDelete: 'restrict' }),
    step: text('step', { enum: ['decision', 'funding'] }).notNull(),
    exposureRial: rial('exposure_rial').notNull(),
    amountRial: rial('amount_rial').notNull(),
    capRial: rial('cap_rial').notNull(),
    basis: text('basis', { enum: ['obligation', 'loan'] }).notNull(),
    includeApprovedUnfunded: boolean('include_approved_unfunded').notNull(),
    configVersionId: uuid('config_version_id').notNull(),
    allowed: boolean('allowed').notNull(),
    ...appendOnlyTimestamps(),
  },
  (t) => [
    index('credit_exposure_checks_application_idx').on(t.creditApplicationId),
    check(
      'credit_exposure_checks_amounts_check',
      sql`${t.exposureRial} >= 0 AND ${t.amountRial} > 0 AND ${t.capRial} > 0
          AND ${t.step} IN ('decision', 'funding') AND ${t.basis} IN ('obligation', 'loan')
          AND ${t.allowed} = (${t.exposureRial} + ${t.amountRial} <= ${t.capRial})`,
    ),
  ],
);
