/**
 * Permission codes (doc 04 §1). Permissions are code; roles, which group them, are data
 * that administrators edit. Every endpoint declares exactly one of these, or an explicit
 * public / self-service marker; the API refuses to start otherwise.
 *
 * Format `module.action` (docs/01): the prefix is a module of API_MODULES. Only modules
 * that exist get codes; each later task adds its own. Adding a code also needs a
 * migration that inserts it into the `permissions` table: the API refuses to start while
 * the two differ.
 */
export const PERMISSIONS = [
  // identity
  'identity.request_totp_reset',
  'identity.approve_totp_reset',
  /** Offboarding a staff or center account, by two people (owner 1405/07/23; 0087). */
  'identity.request_staff_offboarding',
  'identity.approve_staff_offboarding',
  /**
   * ف۱۲ ب۲ (owner 1405/07/26): a patient's login mobile replaced by staff when the previous
   * one is lost, by two people (the first proposes with the evidence seen and the new mobile's
   * code, a second approves; 0091). No role has it by default.
   */
  'identity.change_patient_mobile',
  /**
   * ADR-052 (owner 1405/08/02): approving a new mobile for someone who signs financial
   * approvals; two different people, never the owner of the account (the CEO's and the system
   * admin's roles).
   */
  'identity.request_financial_mobile_change',
  'identity.approve_financial_mobile_change',
  // access: roles and their assignment
  'access.read_roles',
  'access.manage_roles',
  'access.assign_roles',
  /** A doctor granting roles to their own secretaries (doc 04 §2). */
  'access.manage_secretaries',
  // access: the center tree
  'access.read_org',
  'access.manage_org',
  // access: sensitive fields, filtered out of every response without them (doc 04 §4)
  'access.view_treatment',
  'access.view_credit_score',
  'access.view_decision_reasons',
  'access.view_patient_financials',
  // audit
  'audit.read',
  // config: reading values; changing business rules or technical settings (task 0-6)
  'config.read',
  'config.manage_business',
  'config.manage_technical',
  'config.propose_technical',
  'config.approve_technical',
  /** Adding and removing holidays (task 2-1): the system admin; audited. */
  'config.manage_holidays',
  /**
   * Deciding a holiday batch or removal another person asked for, and nothing else (owner
   * 1405/08/02): the CEO's deputy for holidays, a narrow custom role; never asks for one.
   */
  'config.approve_holidays',
  /**
   * The portal's content (owner 1405/08/10): the desk's banners, the text pages and the
   * announcements, proposed by the system admin and decided by another person.
   */
  'config.propose_content',
  /** The second person of the portal's content: support, or another system admin. */
  'config.approve_content',
  // catalog: centers and branches (task 2-2)
  'catalog.read_centers',
  /** Registering and editing centers: the network specialist, a center manager for their own. */
  'catalog.manage_centers',
  /** Evaluating: sending back for a fix, setting document statuses, proposing activation. */
  'catalog.review_centers',
  'catalog.suspend_center',
  /** The second person of an activation or reactivation: the network manager. */
  'catalog.approve_center_activation',
  /**
   * The public partnership requests (owner 1405/08/10): the network specialist reviews one and
   * registers its center as a draft; the network manager, another person, approves it, which
   * makes the center's account and sends its one-time link.
   */
  'catalog.review_partnership',
  'catalog.approve_partnership',
  /** The second person of a new bank account after activation: accounting. */
  'catalog.approve_bank_account_change',
  /** Seeing a full Sheba (everyone else sees the last four digits); recorded as a view. */
  'catalog.view_bank_account',
  // catalog: doctors and their secretaries (task 2-3)
  'catalog.read_doctors',
  /**
   * Registering doctors and their workplaces and secretaries, editing a profile: the
   * network, a center manager at their center, the doctor (or their secretary) for their own.
   */
  'catalog.manage_doctors',
  // catalog: treatment fields, services and tariffs (task 2-4)
  /** Adding, renaming and retiring fields and services: the network manager, the system admin. */
  'catalog.manage_catalog',
  'catalog.read_tariffs',
  /**
   * Setting a price: the center manager for their center and its doctors, a branch manager
   * for their branch's doctors, the doctor for their own workplace, their secretary only if
   * the doctor delegated it.
   */
  'catalog.manage_tariffs',
  /**
   * The network specialist setting the price of a private practice whose doctor has no
   * account (task 2-4 decision); ends for that doctor once they have one.
   */
  'catalog.manage_tariff_for_unaccounted_doctor',
  /**
   * A doctor's visit price from the internal panel, by two people (owner 1405/07/29; 0100):
   * one proposes, another approves; the network specialist and manager, for the workplaces
   * their scope covers.
   */
  'catalog.manage_visit_tariffs',
  /**
   * Whether a doctor's workplace takes Sepehr credit, which the public search filters on
   * (task 2-7 decision 2): the network specialist, for the workplaces of their city; audited.
   */
  'catalog.manage_workplace_credit',
  /**
   * Approving or rejecting a doctor's public profile (task 2-8, doc 08 §10), and changing its
   * address (slug): the network specialist, for doctors of their city.
   */
  'catalog.review_profiles',
  /**
   * The bulk import of centers and doctors from Excel (task 2-9, doc 08 §12): the network
   * specialist, for centers of their city. Prices it carries are only proposed to the center.
   */
  'catalog.import_centers',
  // booking: doctors' calendars and approval modes (task 2-5)
  /** A workplace's weekly schedule, exceptions, approval mode and computed slots. */
  'booking.read_calendar',
  /**
   * Changing a calendar, by who is asking (task 2-5 decision): the doctor with an account
   * for their own workplace, or that workplace's secretary it was delegated to.
   */
  'booking.manage_own_calendar',
  /** The center or branch manager, for the workplaces within their scope. */
  'booking.manage_calendar_in_scope',
  /** Sepehr's operators, for any doctor their global or city scope covers. */
  'booking.manage_any_calendar',
  /**
   * Automatic or manual approval of a workplace's appointments: the doctor with an account,
   * the center or branch manager in scope, Sepehr's operators; never a secretary.
   */
  'booking.manage_approval_mode',
  // booking: appointments and referrals (task 2-6). Patients act on their own appointments
  // without a role (self-service, ownership checked by the service).
  /** A workplace's appointments, for whoever's scope covers it (doctor, secretary, center). */
  'booking.read_appointments',
  /**
   * Answering requests, check-in, examined, no-show, cancelling or moving as the center,
   * recording the visit paid: for whoever's scope covers the workplace.
   */
  'booking.manage_appointments',
  /** An advisor booking for a patient, and seeing the appointments of their own cases. */
  'booking.book_for_patient',
  /** Deciding a patient's dispute of a no-show. */
  'booking.resolve_no_show_dispute',
  /** Referrals: the basis of the cash-service commission (phase 5). */
  'booking.read_referrals',
  // proforma: what a doctor proposes and at what price (task 3-4, doc 10 §2)
  /** Issuing and revising a proforma: the doctor; their secretary only by their own delegation. */
  'proforma.issue',
  /** Proformas of the workplaces one's scope covers; treatment details need access.view_treatment. */
  'proforma.read',
  /** The network's queue of prices outside the tariff, and marking them reviewed. */
  'proforma.review_deviations',
  // credit: applications, scoring and decisions (phase 3, doc 10)
  /** Credit applications, for the credit units; field limits apply (doc 10 §6). */
  'credit.read_applications',
  /** The case-completion specialist sending an application on to credit review. */
  'credit.complete_applications',
  /** Entering raw data and running the scoring engine on it (the credit specialist). */
  'credit.score_applications',
  /** Giving an application of a credit queue to someone by hand, with a required reason. */
  'credit.assign_manually',
  /** Ticking a condition of a conditional approval as met, before funding (task 4-3). */
  'credit.check_conditions',
  /** Sending an application to its decision, and proposing one, with a reason (task 3-6). */
  'credit.propose_decision',
  /** The second check of a decision the credit specialist proposed; never one's own. */
  'credit.decide_second_check',
  /** Deciding where the engine names the credit manager (doc 03 §6). */
  'credit.decide_manager',
  /** Proposing and approving a decision out of the matrix (doc 03 §6, doc 04 §5). */
  'credit.decide_out_of_matrix',
  /** A committee member's vote, for the unit of their role (doc 03 §6). */
  'credit.committee_vote',
  /** «In review / approved / rejected» of a case one may see: never a score or a reason. */
  'credit.read_status',
  /** Cancelling an application before funding (task 4-8): asked by case completion or accounting, decided by another in accounting; its receipts refunded. */
  'credit.request_cancellation',
  'credit.approve_cancellation',
  /** A case's own cancellation-penalty rate, 0 to 18% (task 4-8, owner پ۱۳): asked, then approved by another. */
  'credit.request_penalty_override',
  'credit.approve_penalty_override',
  /**
   * Recording a formation deposit's details, and its refund before the introduction letter
   * (owner 1405/07/29; 0100): case completion. No ledger row in the pilot.
   */
  'credit.record_formation_deposit',
  /** ADR-050: a wage-only application's split of wage and materials checked before its decision. */
  'credit.review_cost_split',
  // contract: loan contracts (task 4-1, doc 12 §2)
  /** Asking for the contract of a decided credit application (case completion). */
  'contract.generate',
  /** Contracts and their PDF, every view logged. */
  'contract.read',
  /** Recording an application completed, once every condition holds (task 4-3, doc 12 §4). */
  'contract.complete',
  /** Paying a refund out by bank (task 4-8, ADR-036): recorded by one in accounting, approved by another. */
  'contract.request_refund_payment',
  'contract.approve_refund_payment',
  /** ADR-048: an officer's discount on the origination fee, under their signature, no second. */
  'contract.grant_origination_discount',
  /** ADR-048: the monthly list of those discounts (accounting, the CEO). */
  'contract.read_origination_discounts',
  // instrument: physical deliveries, cheques and notes (task 4-2, doc 12 §3)
  /** Expecting, receiving, checking and archiving deliveries; registering instruments. */
  'instrument.manage',
  /** Deliveries and instruments, numbers only by their last four digits. */
  'instrument.read',
  /** An instrument's full number, each view logged (doc 04 §7). */
  'instrument.view_numbers',
  /** Proposing a held cheque's execution, of an overdue loan (task 6-8): the collection agent. */
  'instrument.propose_execution',
  /** The collection manager's approval of a cheque's execution, never the proposer (task 6-8). */
  'instrument.approve_execution_collection',
  /** Finance's approval of a cheque's execution: the third person (task 6-8). */
  'instrument.approve_execution_finance',
  /** Recording a presented cheque cleared (through 6-2's receipt) or bounced (task 6-8). */
  'instrument.record_outcome',
  /** Releasing an instrument after full settlement (task 6-8): accounting. */
  'instrument.approve_release',
  /** ADR-052 (owner 1405/08/02): asking for a release; another person approves it. */
  'instrument.request_release',
  // lead: persons, cases and their assignment (task 2-5b, doc 05)
  /** An advisor entering a lead by hand; it goes through the one intake. */
  'lead.intake_manual',
  /** Cases and their persons, by scope: own (an advisor's), queue, city or global. */
  'lead.read_cases',
  /** Working a case one can see: starting advice, closing it with a reason. */
  'lead.update_cases',
  /** Giving a case to someone else by hand, with a required reason. */
  'lead.assign_manually',
  /** The shares of each queue, agents' presence and open-case caps. */
  'lead.manage_assignment',
  /** The editable list of abandonment reasons. */
  'lead.manage_reasons',
  /** Blocking a person (abuse, do not contact) and lifting it. */
  'lead.block_person',
  /** Merging two persons into one, and reverting a merge (task 2-5b decision 6). */
  'lead.merge_persons',
  /**
   * Approving or refusing a mobile added to a Person who already existed (task 9-3), with
   * evidence; never the one who added it. No role has it by default.
   */
  'lead.approve_person_mobile',
  /** Importing patients and leads from a spreadsheet. */
  'lead.import',
  /** The target-versus-actual share of each agent, from the reporting database. */
  'lead.read_distribution_report',
  /** ADR-048: a customer-club membership and its early end (the club officer). */
  'lead.record_club_membership',
  // ledger: reading documents and balances; nothing writes through the API (task 1-1)
  'ledger.read',
  // wallet: reading credit purses (accounting, auditor); nothing writes through the API
  'wallet.read',
  /** Funding a purse (doc 12 §5; task 4-5): asked by case completion, approved by finance. */
  'wallet.request_funding',
  'wallet.approve_funding',
  /** Special operations on a purse (doc 12 §7; task 4-8): asked by finance, decided by another. */
  'wallet.request_special_operation',
  'wallet.approve_special_operation',
  /** A doctor change (task 4-8, owner پ۳): asked by case completion, approved by the credit manager. */
  'wallet.request_doctor_change',
  'wallet.approve_doctor_change',
  /** A credit transfer to an AuthorizedRecipient (task 4-8, owner س۵): asked, then approved by another in accounting. */
  'wallet.request_credit_transfer',
  'wallet.approve_credit_transfer',
  // service: authorizing and recording a service on a funded purse (doc 12 §6; task 4-6)
  /** Authorizing proforma lines and entering the patient's code: the doctor; a secretary by delegation. */
  'service.authorize',
  /** Authorizations of the workplaces one's scope covers, or one's own as the doctor. */
  'service.read',
  /** Cancelling an authorization or a recorded service before it is final: finance only. */
  'service.cancel',
  // repayment: reading schedules and payments; approving a received payment (task 1-3)
  'repayment.read',
  'repayment.approve_payment',
  // settlement: named by doc 04; its endpoints come with the settlement module.
  'settlement.approve',
  /** Opening a dispute on a doctor's payable or a service fee (task 5-2): support, accounting. */
  'settlement.open_dispute',
  /** Deciding a dispute, never one's own: accounting (task 5-2). */
  'settlement.resolve_dispute',
  /** Recording a cash service of a referred patient (task 5-3): an advisor, accounting. */
  'settlement.record_cash_service',
  /** Confirming or voiding a recorded cash service, never one's own record: accounting. */
  'settlement.confirm_cash_service',
  /** Doctors' statements, with their lines (task 5-4): accounting. */
  'settlement.read_statements',
  /** Asking for, and approving, a draft statement's cancellation; never both (task 5-4). */
  'settlement.cancel_statement',
  /** Reviewing and approving a statement, and the bank's tracking number: two people (task 5-5). */
  'settlement.review_statement',
  /** The bank file, with the Sheba in full (task 5-5). */
  'settlement.export_payouts',
  /** A doctor's own statements, PDF, upcoming and held items (task 5-6). */
  'settlement.read_own',
  /** A center's sums over its doctors, without their items (task 5-6). */
  'settlement.read_center_summary',
  /** Accounting's reports: held items and negative balances (task 5-7). */
  'settlement.read_reports',
  /** The Odoo account mapping and the Odoo export (task 5-7). */
  'settlement.manage_odoo_mapping',
  /** SMS templates, versioned, with their allowed fields per recipient (task 6-4). */
  'notification.manage_templates',
  /** What was sent, scheduled or held back, and its delivery (task 6-4). */
  'notification.read_dispatches',
  /** A mobile's consent to promotional SMS, and its withdrawal (task 6-4). */
  'notification.manage_consent',
  /** Bulk SMS: made, previewed, approved by a second person at or below the threshold, paused or stopped (task 6-5). */
  'notification.manage_campaigns',
  /** Approving a bulk SMS above the threshold; never one's own (task 6-5). */
  'notification.approve_campaigns',
  /** One SMS at a chosen Jalali moment, and its cancellation before it is sent (task 6-5). */
  'notification.schedule_sms',
  // collection: the overdue queue (task 6-7; doc 15 §5; owner 1405/07/16)
  /** The queue and a case's follow-up, never its treatment: the unit and its manager. */
  'collection.read_queue',
  /** Calls, visits, letters and the like, recorded by hand: the collection agent. */
  'collection.record_action',
  /** Payment promises, made and cancelled: the collection agent. */
  'collection.manage_promises',
  /** Working tasks: a call made, the guarantor's SMS sent by decision, stage 3-4 proposed. */
  'collection.work_tasks',
  /** Proposing a deceased or disabled status, or lifting it, with its document. */
  'collection.propose_borrower_status',
  /** Approving that status, never one's own proposal: the collection manager only. */
  'collection.approve_borrower_status',
  /** Deciding stage 3 and 4, never one's own proposal: the collection manager only. */
  'collection.decide_escalation',
  /** Assigning by hand, with a reason: the strategy manager (as the credit queues, 3-5). */
  'collection.assign',
  // ticket: tickets (task 7-1; doc 17 §1)
  /** A center's ticket, from a node of the caller's scope: center manager, doctor, secretary. */
  'ticket.open_center',
  /** A ticket for a caller, by mobile (doc 17 §1): support, advisor. */
  'ticket.open_on_behalf',
  /** The queue of the units whose role one holds: reply, internal notes, status, transfer. */
  'ticket.work',
  /** Assigning by hand with a reason, and the deadline notices: the units' managers. */
  'ticket.assign',
  /** Every ticket, read only: CEO, auditor. */
  'ticket.read_all',
  /** A doctor answering a patient's complaint about them (task 7-2): doctor, secretary. */
  'ticket.respond',
  // reporting: reports and exports (task 7-3; doc 17 §2, §4, §5)
  /** Running a report one may (each report has its own permission too), exporting it, own filters. */
  'reporting.run',
  /** Sharing a saved filter with one's unit: the units' managers. */
  'reporting.share_filters',
  /** The full value of encrypted fields in an export, with a reason (doc 17 §5): nobody at first. */
  'reporting.export_sensitive',
  // The version-one reports' audiences (task 7-4; doc 17 §2), each besides reporting.run.
  /** The sales funnel and abandonment: the CEO, the strategy (sales) manager. */
  'reporting.read_sales',
  /** Credit: the CEO, the strategy and credit managers. */
  'reporting.read_credit',
  /** The centers' settlement: the CEO, accounting. */
  'reporting.read_settlement',
  /** Receivables: the CEO, the collection unit and its manager. */
  'reporting.read_receivables',
  /** The agents' performance: the CEO and the units' managers. */
  'reporting.read_agents',
  /** The credit purses' use: the CEO, accounting. */
  'reporting.read_wallet',
  /** The CEO's dashboard (task 7-5; doc 17 §3): the CEO. */
  'reporting.dashboard_ceo',
  /** The search log's reports and index suggestions (task 7-6; doc 17 §6): the system admin. */
  'reporting.read_search',
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number];

export const PERMISSION_CODE_FORMAT = /^[a-z]+\.[a-z][a-z_]*$/;

export function isPermissionCode(value: string): value is PermissionCode {
  return (PERMISSIONS as readonly string[]).includes(value);
}
