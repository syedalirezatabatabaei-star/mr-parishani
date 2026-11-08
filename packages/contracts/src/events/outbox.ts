import * as z from 'zod';

/**
 * Domain events (ADR-005, task 0-7). A module writes an event into the outbox in the same
 * transaction as the change it describes; the worker relays it to this BullMQ queue and
 * hands it to every consumer subscribed to its type, each exactly once in effect.
 */
export const OUTBOX_QUEUE = 'outbox';

/** Event type: `module.what_happened`, past tense (`credit.application_approved`). */
export const EVENT_TYPE_FORMAT = /^[a-z]+\.[a-z][a-z_]*$/;

/** What travels through the queue. The job id is the event id. */
export const eventEnvelopeSchema = z.object({
  id: z.uuid(),
  type: z.string().regex(EVENT_TYPE_FORMAT),
  aggregateType: z.string().regex(/^[a-z][a-z_]*$/),
  aggregateId: z.string().min(1).max(100),
  payload: z.unknown(),
  /** When the change happened: the outbox row's creation time. */
  occurredAt: z.iso.datetime({ offset: true }),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

const centerEvent = z.object({ centerId: z.uuid(), centerNodeId: z.uuid() });
const proformaEvent = z.object({
  proformaId: z.uuid(),
  caseId: z.uuid(),
  doctorId: z.uuid(),
  workplaceId: z.uuid(),
  version: z.int().positive(),
  totalRial: z.string().regex(/^\d+$/),
});

const creditApplicationEvent = z.object({
  creditApplicationId: z.uuid(),
  caseId: z.uuid(),
  proformaId: z.uuid(),
});

const ticketEvent = z.object({
  ticketId: z.uuid(),
  unit: z.string().min(1),
  status: z.string().min(1),
});

const deliveryEvent = z.object({ deliveryId: z.uuid(), creditApplicationId: z.uuid() });

const completionEvent = z.object({ receiptId: z.uuid(), creditApplicationId: z.uuid() });

const contractEvent = z.object({ contractId: z.uuid(), creditApplicationId: z.uuid() });

const creditGuarantorEvent = creditApplicationEvent.extend({ guarantorId: z.uuid() });

const specialOperationEvent = z.object({
  requestId: z.uuid(),
  purseId: z.uuid(),
  kind: z.enum(['cancel_unused', 'reverse_cancel_unused', 'change_doctor', 'cancel_after_funding']),
});

const serviceEvent = z.object({
  authorizationId: z.uuid(),
  purseId: z.uuid(),
  creditApplicationId: z.uuid(),
  workplaceId: z.uuid(),
  amountRial: z.string().regex(/^\d+$/),
});

const appointmentEvent = z.object({
  appointmentId: z.uuid(),
  workplaceId: z.uuid(),
  doctorId: z.uuid(),
  caseId: z.uuid().nullable(),
});

/**
 * Every domain event type and the schema of its payload. Payloads hold ids and amounts
 * (as strings of rials), never personal data (rule 30): consumers look the rest up.
 * Each module adds its own events.
 */
export const DOMAIN_EVENTS: Readonly<Record<string, z.ZodType>> = {
  /** A journal entry was posted to the ledger (task 1-1). */
  'ledger.journal_posted': z.object({
    journalEntryId: z.uuid(),
    entityId: z.string(),
    eventType: z.string(),
    reversesJournalEntryId: z.uuid().nullable(),
  }),
  /** An operation on a credit purse (task 1-2); amount in rials as a string. */
  'wallet.operation_recorded': z.object({
    purseId: z.uuid(),
    caseId: z.uuid(),
    operationId: z.uuid(),
    kind: z.enum([
      'approve',
      'charge',
      'reserve',
      'cancel_reservation',
      'register_service',
      'finalize',
      'cancel_unused',
      'hold',
      'release',
      'reversal',
    ]),
    authorizationId: z.string().nullable(),
    amountRial: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable(),
  }),
  /**
   * A center's status changed (task 2-2, doc 08 §14): submitted (or resubmitted) for
   * review; activated (or reactivated); suspended or terminated, when it takes no new
   * appointment and the booking module (task 2-6) moves its future appointments to the
   * relocation queue.
   */
  'catalog.center_submitted': centerEvent,
  'catalog.center_activated': centerEvent,
  'catalog.center_suspended': centerEvent,
  'catalog.center_terminated': centerEvent,
  /**
   * What the public search (task 2-7, doc 08 §9) must learn besides a center's status.
   * Each only names what changed; the search index reads the rest itself. A center's own
   * details (its name); a doctor's profile or workplaces; a price, from `effectiveAt` (a
   * version may start later); whether a workplace takes credit; a treatment field or
   * service added, renamed or retired (every entry may show it).
   */
  'catalog.center_updated': centerEvent,
  'catalog.doctor_changed': z.object({ doctorId: z.uuid() }),
  'catalog.tariff_changed': z.object({
    tariffId: z.uuid(),
    workplaceId: z.uuid().nullable(),
    centerId: z.uuid().nullable(),
    effectiveAt: z.iso.datetime({ offset: true }),
  }),
  'catalog.workplace_credit_changed': z.object({
    workplaceId: z.uuid(),
    creditEnabled: z.boolean(),
  }),
  /**
   * A version of a doctor's public profile was approved (task 2-8). The worker's media job
   * puts its media in the public space on its own (it reconciles, so no event is needed).
   */
  'catalog.profile_published': z.object({ profileId: z.uuid(), versionId: z.uuid() }),
  'catalog.catalog_item_changed': z.object({
    kind: z.enum(['treatment_field', 'service']),
    code: z.string().min(1).max(100),
  }),
  /**
   * The holiday calendar changed (task 2-7): a national holiday (`cityCode` null) or one
   * city's. Slots of the workplaces it covers change.
   */
  'config.holidays_changed': z.object({
    holidayId: z.uuid(),
    cityCode: z.string().nullable(),
  }),
  /**
   * A login factor changed (task 9-3, R2): the identity module's consumer tells the account
   * by SMS after the commit. The notice row holds the recipient; the payload has no mobile.
   */
  'identity.factor_changed': z.object({ noticeId: z.uuid() }),
  /** A workplace's weekly schedule or an exception changed (task 2-7): its slots change. */
  'booking.calendar_changed': z.object({ workplaceId: z.uuid(), doctorId: z.uuid() }),
  /**
   * Leads (task 2-5b, doc 05). The notification module (later) tells the advisor of a
   * duplicate and the manager of an unassigned case or a blocked intake.
   */
  'lead.case_opened': z.object({
    caseId: z.uuid(),
    personId: z.uuid(),
    category: z.enum(['new', 'returning', 'existing_customer']),
  }),
  'lead.case_assigned': z.object({
    caseId: z.uuid(),
    accountId: z.uuid(),
    kind: z.enum(['auto', 'returning', 'manual']),
  }),
  'lead.case_unassigned': z.object({ caseId: z.uuid(), queueCode: z.string() }),
  'lead.intake_duplicate': z.object({
    caseId: z.uuid(),
    intakeId: z.uuid(),
    advisorAccountId: z.uuid().nullable(),
  }),
  'lead.intake_blocked': z.object({ intakeId: z.uuid(), personId: z.uuid() }),
  /** An import batch was committed; the worker processes its rows. */
  'lead.import_committed': z.object({ batchId: z.uuid() }),
  /**
   * Task 9-3 (go-live blocker م۵): a mobile was added to a Person who already existed, or that
   * pending mobile was approved or refused, or two Persons were merged. The identity module
   * tells the Person's proved mobiles by SMS (R2). Ids only: the recipients are person_mobiles
   * rows, chosen when the change was made.
   */
  'lead.person_mobile_changed': z.object({
    change: z.enum(['added', 'approved', 'rejected']),
    personMobileId: z.uuid().nullable(),
    recipientIds: z.array(z.uuid()),
  }),
  /**
   * Appointments (task 2-6, doc 08 §14), named `booking.*` by the repository's convention.
   * Ids only; the SMS consumer of the booking module looks up what it sends. `cancelled`
   * says by whom; `no_show` is not final until its dispute, if any, is decided
   * (`no_show_dispute_resolved`).
   */
  'booking.appointment_held': appointmentEvent,
  'booking.appointment_requested': appointmentEvent,
  'booking.appointment_confirmed': appointmentEvent,
  'booking.appointment_rejected': appointmentEvent,
  'booking.appointment_expired': appointmentEvent,
  'booking.appointment_cancelled': appointmentEvent.extend({
    by: z.enum(['patient', 'center']),
  }),
  'booking.appointment_rescheduled': appointmentEvent.extend({ newAppointmentId: z.uuid() }),
  'booking.appointment_checked_in': appointmentEvent,
  'booking.appointment_examined': appointmentEvent,
  'booking.appointment_no_show': appointmentEvent,
  'booking.no_show_dispute_resolved': appointmentEvent.extend({
    outcome: z.enum(['upheld', 'overturned']),
  }),
  /** A reminder is due (`booking.reminder_offsets_minutes`); sent once per offset. */
  'booking.appointment_reminder_due': appointmentEvent.extend({
    offsetMinutes: z.number().int().min(1),
  }),
  /** The center did not answer in time (doc 08 §7): the supporting advisor is told. */
  'booking.appointment_approval_overdue': appointmentEvent,
  /** A proforma's life (task 3-4, doc 10 §9): issued, confirmed or disputed by the patient, superseded, expired. */
  'proforma.issued': proformaEvent,
  'proforma.confirmed': proformaEvent,
  'proforma.disputed': proformaEvent,
  'proforma.superseded': proformaEvent,
  'proforma.expired': proformaEvent,
  /** A credit application's life (task 3-5, doc 10 §9). */
  'credit.plan_selected': creditApplicationEvent,
  'credit.submitted': creditApplicationEvent,
  'credit.ready_for_review': creditApplicationEvent,
  'credit.sla_breached': creditApplicationEvent,
  'credit.expired': creditApplicationEvent,
  'credit.consent_given': creditApplicationEvent,
  'credit.borrower_scored': creditApplicationEvent,
  'credit.guarantor_invited': creditGuarantorEvent,
  'credit.guarantor_scored': creditGuarantorEvent,
  'credit.document_rejected': creditApplicationEvent.extend({ documentId: z.uuid() }),
  /** Decisions (task 3-6, doc 10 §6): proposed, closed unconfirmed, and final. */
  'credit.decision_proposed': creditApplicationEvent.extend({ decisionId: z.uuid() }),
  'credit.decision_closed': creditApplicationEvent.extend({ decisionId: z.uuid() }),
  'credit.committee_voted': creditApplicationEvent.extend({ decisionId: z.uuid() }),
  /** Cancelled before funding (task 4-8): its case closed, its receipts refunded. */
  'credit.application_cancelled': creditApplicationEvent.extend({ cancellationId: z.uuid() }),
  'credit.penalty_override_requested': creditApplicationEvent.extend({ overrideId: z.uuid() }),
  'credit.penalty_override_decided': creditApplicationEvent.extend({
    overrideId: z.uuid(),
    approved: z.boolean(),
  }),
  'credit.cancellation_requested': creditApplicationEvent.extend({ cancellationId: z.uuid() }),
  'credit.cancellation_rejected': creditApplicationEvent.extend({ cancellationId: z.uuid() }),
  'credit.decided': creditApplicationEvent.extend({
    decisionId: z.uuid(),
    outcome: z.enum(['approved', 'conditional', 'rejected', 'needs_more_guarantors']),
  }),
  /** A delivery's life (task 4-2, doc 12 §3). */
  'instrument.delivery_received': deliveryEvent,
  'instrument.delivery_verified': deliveryEvent,
  'instrument.delivery_incomplete': deliveryEvent,
  'instrument.delivery_archived': deliveryEvent,
  /** A cheque presented after its three approvals (task 6-8; doc 15 §8). No number. */
  'instrument.presented': z.object({
    instrumentId: z.uuid(),
    executionId: z.uuid(),
    caseId: z.uuid(),
    amountRial: z.string().regex(/^[0-9]+$/),
  }),
  /** Cleared: its money entered through 6-2's receipt and allocation. */
  'instrument.cleared': z.object({
    instrumentId: z.uuid(),
    executionId: z.uuid(),
    caseId: z.uuid(),
    amountRial: z.string().regex(/^[0-9]+$/),
  }),
  /** Bounced: nothing posted; stage 4 of the collection unit. */
  'instrument.bounced': z.object({
    instrumentId: z.uuid(),
    executionId: z.uuid(),
    caseId: z.uuid(),
    reason: z.enum(['insufficient_funds', 'signature_mismatch', 'account_closed', 'other']),
  }),
  /** Released to its owner after full settlement. */
  'instrument.released': z.object({ instrumentId: z.uuid(), caseId: z.uuid() }),
  /** A contract's life (task 4-1, doc 12 §2): asked for, printed, failed, accepted by all. */
  'contract.requested': contractEvent,
  'contract.generated': contractEvent,
  'contract.failed': contractEvent,
  'contract.accepted': contractEvent,
  /** Completion (task 4-3, doc 12 §4): receipts decided by finance; the application completed. */
  'contract.receipt_uploaded': completionEvent,
  'contract.receipt_approved': completionEvent,
  'contract.receipt_rejected': completionEvent,
  'contract.completed': z.object({ creditApplicationId: z.uuid() }),
  /** A refund paid out by bank (task 4-8, ADR-036): recorded, approved (posted) or rejected. */
  'contract.refund_payment_requested': z.object({
    refundPaymentId: z.uuid(),
    creditApplicationId: z.uuid(),
  }),
  'contract.refund_payment_approved': z.object({
    refundPaymentId: z.uuid(),
    creditApplicationId: z.uuid(),
    journalEntryId: z.uuid(),
    amountRial: z.string().regex(/^[0-9]+$/),
  }),
  'contract.refund_payment_rejected': z.object({
    refundPaymentId: z.uuid(),
    creditApplicationId: z.uuid(),
  }),
  /** A cancelled application's receipt refunded (task 4-8): what Aramesh now owes back. */
  'contract.receipt_refunded': z.object({
    creditApplicationId: z.uuid(),
    receiptId: z.uuid(),
    kind: z.enum(['origination_fee', 'plan_fee', 'down_payment']),
    journalEntryId: z.uuid(),
    amountRial: z.string().regex(/^\d+$/),
  }),
  /** The down payment's posting (ADR-034): made, and reversed before funding. */
  'contract.down_payment_posted': z.object({
    creditApplicationId: z.uuid(),
    receiptId: z.uuid(),
    journalEntryId: z.uuid(),
  }),
  'contract.down_payment_reversed': z.object({
    creditApplicationId: z.uuid(),
    receiptId: z.uuid(),
    journalEntryId: z.uuid(),
  }),
  /** Funding (task 4-5, doc 12 §5): asked, refused, and done (the purse charged, the schedule made). */
  'wallet.funding_requested': z.object({
    fundingRequestId: z.uuid(),
    creditApplicationId: z.uuid(),
  }),
  'wallet.funding_rejected': z.object({
    fundingRequestId: z.uuid(),
    creditApplicationId: z.uuid(),
  }),
  'wallet.funded': z.object({
    fundingRequestId: z.uuid(),
    creditApplicationId: z.uuid(),
    caseId: z.uuid(),
    purseId: z.uuid(),
    scheduleId: z.uuid(),
    doctorAccountId: z.uuid().nullable(),
  }),
  /**
   * Services (task 4-6, doc 12 §6, §8): authorized (reserved), a code sent, delivered (the
   * code entered), final, expired, or cancelled by finance. Ids and amounts only.
   */
  'service.authorized': serviceEvent,
  'service.code_sent': serviceEvent,
  'service.delivered': serviceEvent,
  'service.finalized': serviceEvent,
  'service.authorization_expired': serviceEvent,
  'service.cancelled': serviceEvent,
  /**
   * Special operations on a purse (task 4-8, doc 12 §7–§8): asked, refused, and done (what
   * is unused cancelled, by part; or such a cancellation reversed). Ids and amounts only.
   */
  'wallet.special_operation_requested': specialOperationEvent,
  'wallet.special_operation_rejected': specialOperationEvent,
  'wallet.unused_cancelled': specialOperationEvent.extend({
    amountRial: z.string().regex(/^\d+$/),
    loanRial: z.string().regex(/^\d+$/),
    downPaymentRial: z.string().regex(/^\d+$/),
  }),
  /** A doctor's payable for a final credit service, and its fee (task 5-1): ids and amounts. */
  'settlement.payable_accrued': z.object({
    payableId: z.uuid(),
    serviceDeliveryId: z.uuid(),
    doctorNodeId: z.uuid(),
    amountRial: z.string().regex(/^[0-9]+$/),
    feeRial: z.string().regex(/^[0-9]+$/),
    dueAt: z.iso.datetime({ offset: true }),
  }),
  /** A dispute opened, and decided (task 5-2): ids and the outcome only. */
  'settlement.dispute_opened': z.object({
    disputeId: z.uuid(),
    subjectType: z.enum(['doctor_payable', 'service_fee']),
    subjectId: z.uuid(),
  }),
  'settlement.dispute_resolved': z.object({
    disputeId: z.uuid(),
    subjectType: z.enum(['doctor_payable', 'service_fee']),
    subjectId: z.uuid(),
    status: z.enum(['resolved_accepted', 'resolved_rejected', 'accepted_pending_posting']),
  }),
  /** A cash service recorded, and decided (task 5-3): ids and the outcome only. */
  'settlement.cash_service_recorded': z.object({
    cashServiceId: z.uuid(),
    doctorId: z.uuid(),
    source: z.enum(['doctor_declared', 'advisor_recorded']),
  }),
  'settlement.cash_service_decided': z.object({
    cashServiceId: z.uuid(),
    doctorId: z.uuid(),
    status: z.enum(['confirmed', 'voided', 'disputed']),
  }),
  /** A doctor's statement made, and cancelled (task 5-4): ids and totals only. */
  'settlement.statement_generated': z.object({
    statementId: z.uuid(),
    doctorId: z.uuid(),
    periodYear: z.int(),
    periodMonth: z.int(),
    payableRial: z.string().regex(/^-?[0-9]+$/),
  }),
  'settlement.statement_cancelled': z.object({ statementId: z.uuid(), doctorId: z.uuid() }),
  /** Task 6-2: a schedule paid in full (once); the case too, when all of its are. */
  'loan.settled': z.object({
    scheduleId: z.uuid(),
    caseId: z.uuid(),
    purseId: z.uuid(),
    caseCompleted: z.boolean(),
  }),
  /** Task 6-1: an installment due today, or overdue from today (once each). */
  'installment.due': z.object({
    installmentId: z.uuid(),
    scheduleId: z.uuid(),
    caseId: z.uuid(),
    dueOn: z.iso.date(),
    outstandingRial: z.string().regex(/^[0-9]+$/),
  }),
  'installment.overdue': z.object({
    installmentId: z.uuid(),
    scheduleId: z.uuid(),
    caseId: z.uuid(),
    dueOn: z.iso.date(),
    daysPastDue: z.int().min(1),
    outstandingRial: z.string().regex(/^[0-9]+$/),
  }),
  /** An accepted payable dispute posted (task 5-2b): the service taken back. */
  'settlement.dispute_posted': z.object({
    disputeId: z.uuid(),
    payableId: z.uuid(),
    amountRial: z.string().regex(/^[0-9]+$/),
    purseClosed: z.boolean(),
  }),
  'service.authorization_reversed': z.object({
    authorizationId: z.uuid(),
    purseId: z.uuid(),
  }),
  /** Approved, and paid (task 5-5): ids and amounts only. */
  'settlement.statement_approved': z.object({
    statementId: z.uuid(),
    doctorId: z.uuid(),
    payouts: z.int(),
  }),
  'settlement.statement_paid': z.object({ statementId: z.uuid(), doctorId: z.uuid() }),
  'settlement.payout_confirmed': z.object({
    payoutId: z.uuid(),
    statementId: z.uuid(),
    amountRial: z.string().regex(/^[0-9]+$/),
  }),
  /** A purse closed with nothing left open on it (task 4-8). */
  'wallet.purse_closed': z.object({ purseId: z.uuid(), caseId: z.uuid() }),
  /** Cancelled after funding (doc 02 §6): the purse closed, its penalty due on its own day. */
  'wallet.cancelled_after_funding': specialOperationEvent.extend({
    feeWaivedRial: z.string().regex(/^[0-9]+$/),
    /** ADR-045: a cash plan fee's unearned part owed back; absent before it, so optional. */
    planFeeRefundRial: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    penaltyRial: z.string().regex(/^[0-9]+$/),
  }),
  /** A new doctor for the purse (doc 12 §7): its scope's new version; the balance unmoved. */
  'wallet.doctor_changed': specialOperationEvent.extend({ workplaceId: z.uuid() }),
  /** A credit transfer's life (task 4-8): ids only, no name, mobile or national ID (rule 30). */
  'wallet.credit_transfer_requested': z.object({ transferId: z.uuid(), purseId: z.uuid() }),
  'wallet.credit_transfer_approved': z.object({ transferId: z.uuid(), purseId: z.uuid() }),
  'wallet.credit_transfer_rejected': z.object({ transferId: z.uuid(), purseId: z.uuid() }),
  'wallet.credit_transfer_revoke_requested': z.object({ transferId: z.uuid(), purseId: z.uuid() }),
  'wallet.credit_transfer_revoked': z.object({
    transferId: z.uuid(),
    purseId: z.uuid(),
    via: z.enum(['borrower', 'finance']),
  }),
  'wallet.unused_cancellation_reversed': specialOperationEvent.extend({
    reversesRequestId: z.uuid(),
  }),
  /** Who works an application in each credit queue (task 3-5, doc 10 §8). */
  'credit.assigned': creditApplicationEvent.extend({
    queueCode: z.enum(['completion', 'credit', 'committee']),
    accountId: z.uuid(),
    kind: z.enum(['auto', 'manual']),
  }),
  'credit.unassigned': creditApplicationEvent.extend({
    queueCode: z.enum(['completion', 'credit', 'committee']),
  }),
  /** One per appointment made through Sepehr (doc 08 §8). */
  'booking.referral_created': z.object({
    referralId: z.uuid(),
    appointmentId: z.uuid(),
    personId: z.uuid(),
    caseId: z.uuid().nullable(),
    supersedesReferralId: z.uuid().nullable(),
  }),
  /** A bulk SMS approved by a second person, its recipients fixed (task 6-5; doc 15 §8). */
  'sms.campaign_approved': z.object({
    campaignId: z.uuid(),
    recipientCount: z.int().min(0),
    templateId: z.uuid(),
  }),
  /** Nothing of a bulk SMS left to send (task 6-5; doc 15 §8). */
  'sms.campaign_completed': z.object({
    campaignId: z.uuid(),
    dispatched: z.int().min(0),
    cancelled: z.int().min(0),
  }),
  /**
   * Tickets (task 7-1; doc 17 §8): ids, unit and status only, never their text (rule 30).
   */
  'ticket.opened': ticketEvent,
  'ticket.assigned': ticketEvent.extend({ assigneeAccountId: z.uuid() }),
  'ticket.sla_warning': ticketEvent.extend({ dueAt: z.iso.datetime({ offset: true }) }),
  'ticket.sla_breached': ticketEvent.extend({ dueAt: z.iso.datetime({ offset: true }) }),
  'ticket.resolved': ticketEvent,
  'ticket.reopened': ticketEvent,
  /** A financial complaint, its item held by a dispute (task 7-2; doc 17 §8). */
  'complaint.financial_opened': ticketEvent.extend({ disputeId: z.uuid() }),
  /** An export recorded (task 7-3; doc 17 §8): ids and counts only. */
  'report.exported': z.object({
    exportId: z.uuid(),
    reportCode: z.string().min(1),
    format: z.enum(['csv', 'pdf']),
    rowCount: z.int().min(0),
    sensitive: z.boolean(),
  }),
  /** Repayment (task 1-3): a schedule created, a receipt registered, approved or rejected. */
  'repayment.recorded': z.object({
    scheduleId: z.uuid(),
    caseId: z.uuid(),
    kind: z.enum([
      'schedule_created',
      'receipt_registered',
      'payment_approved',
      'payment_rejected',
      // A revision of the schedule (task 4-8): a cancelled part taken off, or put back.
      'schedule_revised',
    ]),
    paymentId: z.uuid().nullable(),
    amountRial: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable(),
  }),
};
