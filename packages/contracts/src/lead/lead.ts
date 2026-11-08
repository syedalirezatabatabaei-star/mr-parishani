import * as z from 'zod';
import { normalizeDigits } from '../text/digits.js';
import { mobileSchema } from '../identity/auth.js';
import { normalizeNationalId } from '../text/national-id.js';
import { normalizePersianText } from '../text/persian.js';

/**
 * Leads, persons and cases (task 2-5b, doc 05). Every source goes through one intake:
 * the app, the WordPress form, the Excel import and an advisor. Mobiles, national IDs and
 * names are normalized by the task 0-3 functions before any comparison or storage (rules
 * 23 and 24); nothing here normalizes them another way.
 */

const code = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const reason = text(3, 500);

/** Case statuses (docs/01): the pipeline, then the loan, then the end. */
export const CASE_STATUSES = [
  'new',
  'advising',
  'appointment_booked',
  'examined',
  'proforma_issued',
  'credit_requested',
  'credit_decided',
  'contracted',
  'funded',
  'in_treatment',
  'completed',
  'cancelled',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Before a contract: a person has at most one such case at a time. */
export const OPEN_CASE_STATUSES: readonly CaseStatus[] = [
  'new',
  'advising',
  'appointment_booked',
  'examined',
  'proforma_issued',
  'credit_requested',
  'credit_decided',
];
/** A loan in progress (task 2-5b decision 3, provisional). */
export const LOAN_CASE_STATUSES: readonly CaseStatus[] = ['contracted', 'funded', 'in_treatment'];
export const CLOSED_CASE_STATUSES: readonly CaseStatus[] = ['completed', 'cancelled'];
/**
 * Where a case whose loan is settled is completed from directly (owner 1405/07/23, option A,
 * migration 0086): every open stage before the loan that the funnel reaches. `new` is never
 * passed on (owner 1405/07/15), and `in_treatment` -> `completed` is the chain's own step.
 */
export const SETTLEABLE_CASE_STATUSES: readonly CaseStatus[] = [
  'advising',
  'appointment_booked',
  'examined',
  'proforma_issued',
];
/**
 * The funnel (owner 1405/07/23, question 8): the stage each event brings a case to, in the
 * order of the chain. Each target is reached only from the one before it, `advising` (which
 * has no event) being passed on the way from `new`.
 */
export const CASE_FUNNEL_TARGETS = {
  'booking.appointment_confirmed': 'appointment_booked',
  'booking.appointment_examined': 'examined',
  'proforma.issued': 'proforma_issued',
} as const satisfies Record<string, CaseStatus>;

/** What an intake turned out to be (doc 05 §4). */
export const INTAKE_CATEGORIES = [
  'new',
  'duplicate_active',
  'returning',
  'existing_customer',
  'blocked',
] as const;
export type IntakeCategory = (typeof INTAKE_CATEGORIES)[number];

export const INTAKE_CHANNELS = ['app', 'wordpress', 'excel', 'advisor'] as const;
export type IntakeChannel = (typeof INTAKE_CHANNELS)[number];

/** The work queues an intake lands in (doc 05 §4, §6). */
export const ADVISORY_QUEUE = 'advisory';
export const EXISTING_CUSTOMERS_QUEUE = 'existing_customers';

export const BLOCK_KINDS = ['abuse', 'do_not_contact'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const AGENT_PRESENCE = ['present', 'on_leave', 'absent'] as const;
export type AgentPresence = (typeof AGENT_PRESENCE)[number];

/** The base abandonment reasons (doc 05 §5); the list is edited from the panel. */
export const BASE_ABANDONMENT_REASONS = [
  'price_too_high',
  'guarantor_rejected',
  'credit_rejected',
  'chose_cash',
  'chose_competitor',
  'treatment_cancelled',
  'unreachable',
  'other',
] as const;
/** Tied to the cash-service commission (doc 05 §5): never retired. */
export const CASH_ABANDONMENT_REASON = 'chose_cash';

export const nationalIdInputSchema = z.string().transform((v, ctx) => {
  const id = normalizeNationalId(v);
  if (id === null) {
    ctx.addIssue({ code: 'custom', message: 'not a valid national ID' });
    return z.NEVER;
  }
  return id;
});

const utmValue = z
  .string()
  .transform((v) => normalizeDigits(v).trim())
  .pipe(z.string().max(200));

export const utmSchema = z
  .object({
    source: utmValue.optional(),
    medium: utmValue.optional(),
    campaign: utmValue.optional(),
    term: utmValue.optional(),
    content: utmValue.optional(),
  })
  .strict();
export type Utm = z.output<typeof utmSchema>;

/** What an advisor enters by hand. */
export const manualIntakeSchema = z.object({
  mobile: mobileSchema,
  name: text(2, 200).optional(),
  nationalId: nationalIdInputSchema.optional(),
  treatmentFieldCode: code,
  cityCode: code.optional(),
  smsConsent: z.boolean().default(false),
  note: text(2, 1000).optional(),
});
export type ManualIntake = z.input<typeof manualIntakeSchema>;

/**
 * The WordPress form (doc 05 §7), sent server to server and signed. `website` is a
 * honeypot the form hides from people: a bot that fills it is dropped quietly.
 */
export const webhookIntakeSchema = z.object({
  mobile: mobileSchema,
  treatmentFieldCode: code,
  name: text(2, 200).optional(),
  cityCode: code.optional(),
  smsConsent: z.boolean().default(false),
  utm: utmSchema.optional(),
  pageUrl: z.string().max(2000).optional(),
  /** Task 8-2: the page that sent the visitor to the form, as the plugin saw it. */
  referrer: z.string().max(2000).optional(),
  website: z.string().max(500).optional(),
});
export type WebhookIntake = z.input<typeof webhookIntakeSchema>;

export const cancelCaseSchema = z.object({
  reasonCode: code,
  note: text(2, 1000).optional(),
});

export const assignCaseSchema = z.object({ accountId: z.uuid(), reason });

export const createAbandonmentReasonSchema = z.object({
  code,
  title: text(2, 200),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  reason,
});
export const updateAbandonmentReasonSchema = z.object({
  title: text(2, 200).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  reason,
});
export const retireSchema = z.object({ reason });

/**
 * A new version of the shares of one queue, optionally for one city and treatment field
 * (doc 05 §6). Whole percents summing to 100; zero takes nothing.
 */
export const setAssignmentWeightsSchema = z
  .object({
    queueCode: code,
    cityCode: code.optional(),
    treatmentFieldCode: code.optional(),
    shares: z
      .array(z.object({ accountId: z.uuid(), percent: z.number().int().min(0).max(100) }))
      .min(1)
      .max(200),
    reason,
  })
  .refine((w) => w.shares.reduce((s, x) => s + x.percent, 0) === 100, {
    message: 'the shares must sum to 100',
  })
  .refine((w) => new Set(w.shares.map((s) => s.accountId)).size === w.shares.length, {
    message: 'an account appears twice',
  });
export type SetAssignmentWeights = z.input<typeof setAssignmentWeightsSchema>;

export const setPresenceSchema = z.object({ status: z.enum(AGENT_PRESENCE), reason });
/** Null: no cap. */
export const setCapSchema = z.object({
  maxOpenCases: z.number().int().min(0).max(100_000).nullable(),
  reason,
});

export const blockPersonSchema = z.object({ kind: z.enum(BLOCK_KINDS), reason });
export const unblockPersonSchema = z.object({ reason });

export const mergePersonsSchema = z
  .object({ survivorId: z.uuid(), mergedId: z.uuid(), reason })
  .refine((m) => m.survivorId !== m.mergedId, { message: 'a person is not merged into itself' });
export const revertMergeSchema = z.object({ reason });

/** `POST /lead/person-merges`. */
export const mergeResultSchema = z.object({ mergeId: z.uuid(), movedCaseIds: z.array(z.uuid()) });
/** `POST /lead/person-merges/:id/revert`. */
export const revertMergeResultSchema = z.object({ restoredCaseIds: z.array(z.uuid()) });

/**
 * Staff on a pending mobile (task 9-3; two people, owner 1405/07/23): the first proposes with
 * the evidence seen, a second approves with a reason; refusing takes one.
 */
export const proposePersonMobileSchema = z.object({ reason, evidence: text(3, 500) });
export const approvePersonMobileSchema = z.object({ reason });
export const rejectPersonMobileSchema = z.object({ reason });

const instant = z.iso.datetime({ offset: true });

/**
 * A patient's pending mobiles (task 9-3): whether their own login's mobile is pending (then
 * they see nothing of the Person), and those added to their Person awaiting their decision,
 * by the last four digits only.
 */
export const myPersonMobilesSchema = z.object({
  ownMobilePending: z.boolean(),
  awaitingDecision: z.array(
    z.object({
      id: z.uuid(),
      mobileLast4: z.string().regex(/^[0-9]{4}$/),
      addedAt: instant,
      expiresAt: instant.nullable(),
    }),
  ),
});
export type MyPersonMobiles = z.infer<typeof myPersonMobilesSchema>;

export const personMobileDecisionSchema = z.object({
  id: z.uuid(),
  decision: z.enum(['approved', 'rejected']),
});

export const personMobileProposalSchema = z.object({ id: z.uuid(), proposedBy: z.uuid() });

const proposal = z.object({ proposedBy: z.uuid(), proposedAt: instant });

/**
 * A pending mobile staff with lead.approve_person_mobile may decide on (task 9-3): the last
 * four digits only, masked by the server (owner 1405/07/23).
 */
const pendingPersonMobile = z.object({
  id: z.uuid(),
  personId: z.uuid(),
  mobileLast4: z.string().regex(/^[0-9]{4}$/),
  addedVia: z.enum(['person_created', 'intake', 'import', 'credit_transfer', 'merge']).nullable(),
  addedBy: z.uuid().nullable(),
  addedAt: instant,
  expiresAt: instant.nullable(),
  hasProvedMobile: z.boolean(),
  proposal: proposal.nullable(),
});
export const pendingPersonMobilesSchema = z.array(pendingPersonMobile);

/** Its decision page: the whole number, each view recorded. */
export const personMobileForStaffSchema = pendingPersonMobile.extend({
  mobile: z.string().regex(/^9[0-9]{9}$/),
  proposalDetail: proposal.extend({ reason: z.string(), evidence: z.string() }).nullable(),
});

export const distributionQuerySchema = z.object({
  queueCode: code,
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

export const commitImportSchema = z.object({ reason });
export const cancelImportSchema = z.object({ reason });

/**
 * A value that a spreadsheet would read as a formula (`=`, `+`, `-`, `@`, and a tab or
 * carriage return that some apps strip first), made plain text for a downloadable report
 * (CSV injection).
 */
export function neutralizeSpreadsheetValue(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** One CSV field: neutralized, then quoted. */
export function csvField(value: string | number | null | undefined): string {
  const plain = neutralizeSpreadsheetValue(
    value === null || value === undefined ? '' : String(value),
  );
  return `"${plain.replaceAll('"', '""')}"`;
}

// --- the Excel import of patients and leads (doc 05 §8) -----------------------------------

/**
 * The columns of the import sheet, by header: the code or its Persian title. Only
 * `mobile` and `treatment_field_code` are required.
 */
export const LEAD_IMPORT_COLUMNS = [
  { code: 'mobile', title: 'موبایل', required: true },
  { code: 'name', title: 'نام', required: false },
  { code: 'national_id', title: 'کد ملی', required: false },
  { code: 'treatment_field_code', title: 'کد فیلد درمان', required: true },
  { code: 'city_code', title: 'کد شهر', required: false },
  { code: 'sms_consent', title: 'رضایت پیامک', required: false },
] as const;
export type LeadImportColumn = (typeof LEAD_IMPORT_COLUMNS)[number]['code'];

/**
 * Limits of one upload (task 2-5b decision 2): the file as sent, the rows of its first
 * sheet, and what its parts may inflate to (against a zip bomb).
 */
export const LEAD_IMPORT_LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxRows: 5_000,
  maxInflatedBytes: 50 * 1024 * 1024,
  maxZipEntries: 200,
} as const;

// --- what the case routes answer (owner 1405/07/24, the advisor's pages, م۹) -------------

const instantString = z.iso.datetime({ offset: true });

/** A case in a list, as `GET /lead/cases` gives it. */
export const caseViewSchema = z.object({
  id: z.uuid(),
  personId: z.uuid(),
  status: z.enum(CASE_STATUSES),
  queueCode: z.string(),
  treatmentFieldCode: z.string(),
  cityCode: z.string().nullable(),
  channel: z.enum(INTAKE_CHANNELS),
  isReturning: z.boolean(),
  assigneeAccountId: z.uuid().nullable(),
  abandonmentReasonCode: z.string().nullable(),
  createdAt: instantString,
  closedAt: instantString.nullable(),
});
export type CaseViewBody = z.infer<typeof caseViewSchema>;

/** The Person of a case, as staff with the case see it (approved mobiles; four digits of the ID). */
export const casePersonSchema = z.object({
  id: z.uuid(),
  displayName: z.string().nullable(),
  mobiles: z.array(z.string()),
  pendingMobiles: z.array(
    z.object({
      id: z.uuid(),
      mobile: z.string(),
      addedVia: z.string().nullable(),
      addedAt: instantString,
      expiresAt: instantString.nullable(),
    }),
  ),
  nationalIdLast4: z.string().nullable(),
  blocked: z
    .object({ kind: z.enum(BLOCK_KINDS), at: instantString, reason: z.string() })
    .nullable(),
  smsOptedOutAt: instantString.nullable(),
});

/** `GET /lead/cases/:id`. */
export const caseDetailSchema = caseViewSchema.extend({
  person: casePersonSchema,
  intakes: z.array(
    z.object({ id: z.uuid(), category: z.string(), channel: z.string(), at: instantString }),
  ),
  assignments: z.array(
    z.object({
      accountId: z.uuid().nullable(),
      kind: z.string(),
      reason: z.string().nullable(),
      at: instantString,
    }),
  ),
  statusChanges: z.array(
    z.object({
      from: z.string().nullable(),
      to: z.string(),
      reasonCode: z.string().nullable(),
      at: instantString,
    }),
  ),
  previous: z
    .object({
      caseId: z.uuid(),
      status: z.enum(CASE_STATUSES),
      abandonmentReasonCode: z.string().nullable(),
      closedAt: instantString.nullable(),
      advisorAccountId: z.uuid().nullable(),
    })
    .nullable(),
});
export type CaseDetailBody = z.infer<typeof caseDetailSchema>;

/** `POST /lead/intakes`: what the intake turned out to be (doc 05 §4). */
export const intakeResultSchema = z.object({
  intakeId: z.uuid(),
  category: z.enum(INTAKE_CATEGORIES),
  personId: z.uuid(),
  personCreated: z.boolean(),
  caseId: z.uuid().nullable(),
  caseCreated: z.boolean(),
  assigneeAccountId: z.uuid().nullable(),
  nationalIdConflict: z.boolean(),
});

/** One abandonment reason: `POST` and `PATCH /lead/abandonment-reasons`. */
export const abandonmentReasonSchema = z.object({
  code: z.string(),
  title: z.string(),
  sortOrder: z.int(),
});
/** `GET /lead/abandonment-reasons`. */
export const abandonmentReasonListSchema = z.array(abandonmentReasonSchema);
/** `POST /lead/abandonment-reasons/:code/retire`. */
export const retiredSchema = z.object({ retired: z.literal(true) });
/** `GET /lead/case-completions`: settled cases still new, left to staff (owner 1405/07/15). */
export const completionAlertListSchema = z.array(
  caseViewSchema.extend({ settledAt: instantString }),
);

// --- the assignment page (owner 1405/07/24) -----------------------------------------------

/** One version of a queue's shares (doc 05 §6). */
export const sharesViewSchema = z.object({
  versionId: z.uuid(),
  queueCode: z.string(),
  cityCode: z.string().nullable(),
  treatmentFieldCode: z.string().nullable(),
  effectiveAt: instantString,
  shares: z.array(z.object({ accountId: z.uuid(), percent: z.int() })),
});
/** A share as the page reads it: with the agent's display name, else username. */
export const namedShareSchema = z.object({
  accountId: z.uuid(),
  percent: z.int(),
  name: z.string().nullable(),
  /** The agent's presence in force: `present` when never set (the engine's rule). */
  presence: z.enum(AGENT_PRESENCE),
  /** The open-case cap in force: null when never set, or set to none. */
  maxOpenCases: z.int().nullable(),
});

/** `GET /lead/agents/by-username/:username`: an active staff account, no mobile. */
export const agentViewSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string().nullable(),
});

/** `GET /lead/assignment/distribution`: target against actual, per version. */
export const distributionReportSchema = z.array(
  z.object({
    versionId: z.uuid(),
    cityCode: z.string().nullable(),
    treatmentFieldCode: z.string().nullable(),
    effectiveAt: instantString,
    agents: z.array(
      z.object({
        accountId: z.uuid(),
        targetPercent: z.int(),
        received: z.int(),
        actualBasisPoints: z.int(),
      }),
    ),
  }),
);

/**
 * `GET /lead/persons/:id/merges` (owner 1405/07/24, the merge page): the merges this person
 * survived, newest first, each with what undoing it would need.
 */
export const personMergeViewSchema = z.object({
  id: z.uuid(),
  mergedId: z.uuid(),
  movedCaseIds: z.array(z.uuid()),
  reason: z.string(),
  at: instantString,
  revertedAt: instantString.nullable(),
});

// --- the Excel import of leads (doc 05 §8; task 2-5b) ---------------------------------------

/** `POST /lead/imports` and `GET /lead/imports/:id`: what the batch would do. */
export const leadImportPreviewSchema = z.object({
  batchId: z.uuid(),
  status: z.enum(['previewed', 'committed', 'processed', 'cancelled']),
  rowCount: z.int(),
  newCount: z.int(),
  existingCount: z.int(),
  errorCount: z.int(),
  errors: z.array(z.object({ row: z.int(), codes: z.array(z.string()) })),
});
/** `POST /lead/imports/:id/commit`. */
export const leadImportCommittedSchema = z.object({
  batchId: z.uuid(),
  status: z.literal('committed'),
});
/** `POST /lead/imports/:id/cancel`: rows undone, and the rows kept because someone acted. */
export const leadImportCancelledSchema = z.object({
  batchId: z.uuid(),
  undone: z.int(),
  keptRows: z.array(z.int()),
});

/** `POST /leads/intake` (the WordPress form, task 8-1): accepted, or the same request again. */
export const webhookReceivedSchema = z.object({ received: z.literal(true), replayed: z.boolean() });
