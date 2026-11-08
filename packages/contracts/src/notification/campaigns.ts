import * as z from 'zod';
import { parseJalaliDate } from '../jalali/format.js';
import { fromJalali } from '../jalali/tehran.js';
import { SMS_CATEGORIES } from './sms.js';

/**
 * Scheduled and bulk SMS (task 6-5; doc 15 §7; owner 1405/07/16). A campaign's recipients
 * come from one of a fixed set of named filters (decision ت۸: filters in code, never a
 * general engine); each filter has its parameters and the template fields it can fill.
 * Approval is always by a second person; the threshold only decides who may approve.
 */

export const CAMPAIGN_AUDIENCES = ['patient', 'borrower', 'guarantor'] as const;
export type CampaignAudience = (typeof CAMPAIGN_AUDIENCES)[number];

const days = z.int().min(1).max(3650);

/** Tehran wall time, entered in Jalali: `1405/07/20` and `08:30`. */
export const jalaliMomentSchema = z.strictObject({
  date: z.string().refine((d) => parseJalaliDate(d) !== null, { message: 'not a Jalali date' }),
  time: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
});
export type JalaliMoment = z.infer<typeof jalaliMomentSchema>;

/** The UTC instant of a Jalali moment, Tehran (rule 21). */
export function jalaliMomentToDate(m: JalaliMoment): Date {
  const day = parseJalaliDate(m.date);
  if (!day) throw new RangeError('not a Jalali date');
  const [hour = 0, minute = 0] = m.time.split(':').map(Number);
  return fromJalali(day, { hour, minute });
}

export const CAMPAIGN_FILTERS = {
  /** Borrowers with an installment this many days or more past due (repayment's port). */
  borrowers_overdue_at_least: {
    audience: 'borrower',
    params: z.strictObject({ days }),
    fields: ['name', 'days_overdue', 'amount'],
  },
  /** Borrowers with an installment still open. */
  borrowers_active: {
    audience: 'borrower',
    params: z.strictObject({}),
    fields: ['name'],
  },
  /** The guarantors of loans this many days or more past due: never the treatment. */
  guarantors_overdue_at_least: {
    audience: 'guarantor',
    params: z.strictObject({ days }),
    fields: ['name', 'borrower_name', 'days_overdue', 'amount'],
  },
  /** Patients with a confirmed, attended or examined appointment at these workplaces. */
  patients_of_center: {
    audience: 'patient',
    params: z.strictObject({
      workplaceIds: z.array(z.uuid()).min(1).max(50),
      from: z
        .string()
        .refine((d) => parseJalaliDate(d) !== null)
        .optional(),
      to: z
        .string()
        .refine((d) => parseJalaliDate(d) !== null)
        .optional(),
    }),
    fields: ['name'],
  },
} as const satisfies Record<
  string,
  { audience: CampaignAudience; params: z.ZodType; fields: readonly string[] }
>;
export type CampaignFilterCode = keyof typeof CAMPAIGN_FILTERS;
export const CAMPAIGN_FILTER_CODES = Object.keys(CAMPAIGN_FILTERS) as CampaignFilterCode[];

export const CAMPAIGN_STATUSES = [
  'draft',
  'sending',
  'paused',
  'stopped',
  'completed',
  'cancelled',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** Why a filtered person gets nothing: told in the preview, counted at approval. */
export const CAMPAIGN_EXCLUSIONS = [
  'no_mobile',
  'held',
  'no_consent',
  'unsubscribed',
  'duplicate_mobile',
] as const;
export type CampaignExclusion = (typeof CAMPAIGN_EXCLUSIONS)[number];

const reason = z.string().trim().min(3).max(500);

export const createCampaignSchema = z.strictObject({
  name: z.string().trim().min(2).max(200),
  filterCode: z.enum(CAMPAIGN_FILTER_CODES as [CampaignFilterCode, ...CampaignFilterCode[]]),
  filterParams: z.record(z.string(), z.unknown()).default({}),
  templateCode: z.string().min(3).max(100),
  /** When sending may start; now when left out. */
  sendFrom: jalaliMomentSchema.optional(),
});

export const campaignReasonSchema = z.strictObject({ reason });

const excludedSchema = z.partialRecord(z.enum(CAMPAIGN_EXCLUSIONS), z.int().min(0));

export const campaignViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  audience: z.enum(CAMPAIGN_AUDIENCES),
  filterCode: z.string(),
  filterParams: z.record(z.string(), z.unknown()),
  templateCode: z.string(),
  templateVersion: z.int(),
  category: z.enum(SMS_CATEGORIES),
  status: z.enum(CAMPAIGN_STATUSES),
  /** Locked when the campaign was made: above it, only a holder of approve_campaigns. */
  twoPersonThreshold: z.int(),
  recipientCount: z.int().nullable(),
  excluded: excludedSchema.nullable(),
  costEstimateRial: z.string().nullable(),
  sendFrom: z.iso.datetime({ offset: true }),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  approvedBy: z.uuid().nullable(),
  approvedAt: z.iso.datetime({ offset: true }).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CampaignView = z.infer<typeof campaignViewSchema>;

export const campaignPreviewSchema = z.object({
  recipientCount: z.int(),
  excluded: excludedSchema,
  /** The text one real recipient would get; null when nobody is left. */
  sample: z.string().nullable(),
  segments: z.int(),
  costEstimateRial: z.string(),
  twoPersonThreshold: z.int(),
  /** Above the threshold: only a holder of approve_campaigns approves (owner). */
  needsApproveCampaigns: z.boolean(),
});
export type CampaignPreview = z.infer<typeof campaignPreviewSchema>;

export const campaignReportSchema = z.object({
  recipients: z.object({ pending: z.int(), dispatched: z.int(), cancelled: z.int() }),
  /** Of what was dispatched: the message's own status (sent, delivered, failed, ...). */
  dispatches: z.record(z.string(), z.int()),
  excluded: excludedSchema.nullable(),
});
export type CampaignReport = z.infer<typeof campaignReportSchema>;

/** One SMS at a chosen Jalali moment (task 6-5), to a person or, for staff, a mobile. */
export const scheduleSmsSchema = z
  .strictObject({
    templateCode: z.string().min(3).max(100),
    personId: z.uuid().optional(),
    mobile: z.string().min(10).max(14).optional(),
    values: z.record(z.string(), z.string().max(200)).default({}),
    sendAt: jalaliMomentSchema,
    reason,
  })
  .refine((s) => (s.personId === undefined) !== (s.mobile === undefined), {
    message: 'a person or a mobile, one of them',
  });

export const scheduledSmsViewSchema = z.object({
  dispatchId: z.uuid(),
  status: z.string(),
  sendAfter: z.iso.datetime({ offset: true }),
});
