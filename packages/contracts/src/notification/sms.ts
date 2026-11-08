import * as z from 'zod';
import { fromJalali, toJalaliDateTime } from '../jalali/tehran.js';
import { addJalaliDays } from '../jalali/calendars.js';

/**
 * The notification module's SMS (task 6-4; doc 15 §7): categories, templates with their
 * allowed fields per recipient, segments and the allowed hours. Pure; the API applies them.
 */

/**
 * transactional: always allowed (reminders, overdue, statuses). promotional: only with
 * consent, never after unsubscribing. urgent: login and service codes, the only ones sent
 * outside the allowed hours.
 */
export const SMS_CATEGORIES = ['transactional', 'promotional', 'urgent'] as const;
export type SmsCategory = (typeof SMS_CATEGORIES)[number];

export const SMS_AUDIENCES = ['patient', 'borrower', 'guarantor', 'doctor', 'staff'] as const;
export type SmsAudience = (typeof SMS_AUDIENCES)[number];

const COMMON = ['name', 'case_number', 'amount', 'due_date', 'installment_number', 'link'] as const;

/**
 * The fields a template may use, per recipient (doc 15 §7; doc 04 §4): a guarantor never
 * learns the treatment, the doctor, the center or the score; nor does anyone by SMS learn a
 * score. A template using another field cannot be saved.
 */
export const SMS_TEMPLATE_FIELDS: Readonly<Record<SmsAudience, readonly string[]>> = {
  patient: [...COMMON, 'doctor_name', 'center_name', 'appointment_time', 'treatment_field'],
  borrower: [...COMMON, 'doctor_name', 'center_name', 'treatment_field', 'days_overdue'],
  guarantor: [...COMMON, 'borrower_name', 'days_overdue'],
  doctor: [...COMMON, 'patient_name', 'period'],
  // Owner 1405/08/10: a partnership applicant's username and a rejection's reason.
  staff: [...COMMON, 'count', 'username', 'reason'],
};

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** The fields a body uses, in order of first use. */
export function templateFields(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    const field = m[1] ?? '';
    if (!out.includes(field)) out.push(field);
  }
  return out;
}

/** The fields a body uses that this recipient may not see; empty when it may be saved. */
export function forbiddenFields(audience: SmsAudience, body: string): string[] {
  const allowed = SMS_TEMPLATE_FIELDS[audience];
  return templateFields(body).filter((f) => !allowed.includes(f));
}

/** The body filled; a field without a value is refused (never sent half-filled). */
export function renderTemplate(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(PLACEHOLDER, (_, field: string) => {
    const value = values[field];
    if (value === undefined) throw new RangeError(`no value for ${field}`);
    return value;
  });
}

/** GSM 03.38's basic set: a text only of these is sent as GSM-7, else as UCS-2 (Persian). */
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';

/**
 * How many SMS parts a text takes (doc 15 §7: Persian 70 characters a part): UCS-2 70, or
 * 67 a part when more than one; GSM-7 160, or 153 (an extended character counts twice).
 */
export function smsSegments(text: string): number {
  if (text.length === 0) return 0;
  let gsm = true;
  let septets = 0;
  for (const ch of text) {
    if (GSM7.includes(ch)) septets += 1;
    else if (GSM7_EXTENDED.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return septets <= 160 ? 1 : Math.ceil(septets / 153);
  // UTF-16 code units: what the operator counts.
  const units = text.length;
  return units <= 70 ? 1 : Math.ceil(units / 67);
}

export const allowedHoursSchema = z
  .strictObject({
    /** Tehran hour the window opens (inclusive) and closes (exclusive). */
    fromHour: z.int().min(0).max(23),
    toHour: z.int().min(1).max(24),
  })
  .refine((h) => h.fromHour < h.toHour, { message: 'the window opens before it closes' });
export type AllowedHours = z.infer<typeof allowedHoursSchema>;

/**
 * When a non-urgent SMS may be sent (doc 15 §7, test 9): now, inside the Tehran window;
 * else its next opening, today's or tomorrow's.
 */
export function nextAllowedAt(now: Date, hours: AllowedHours): Date {
  const t = toJalaliDateTime(now);
  if (t.hour >= hours.fromHour && t.hour < hours.toHour) return now;
  const day = { year: t.year, month: t.month, day: t.day };
  const opens = t.hour < hours.fromHour ? day : addJalaliDays(day, 1);
  return fromJalali(opens, { hour: hours.fromHour });
}

// --- the API's shapes ---------------------------------------------------------------------

export const SMS_TEMPLATE_CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export const createSmsTemplateSchema = z.strictObject({
  code: z.string().regex(SMS_TEMPLATE_CODE),
  audience: z.enum(SMS_AUDIENCES),
  category: z.enum(SMS_CATEGORIES),
  body: z.string().trim().min(2).max(1000),
  reason: z.string().trim().min(3).max(500),
});

export const smsTemplateViewSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  version: z.int(),
  audience: z.enum(SMS_AUDIENCES),
  category: z.enum(SMS_CATEGORIES),
  body: z.string(),
  fields: z.array(z.string()),
  /** Parts of the body as written (placeholders filled make it longer). */
  segments: z.int(),
  reason: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type SmsTemplateView = z.infer<typeof smsTemplateViewSchema>;

export const SMS_DISPATCH_STATUSES = [
  'pending',
  'scheduled',
  'sent',
  'delivered',
  'failed',
  'suppressed',
  'cancelled',
] as const;
export type SmsDispatchStatus = (typeof SMS_DISPATCH_STATUSES)[number];

export const smsDispatchViewSchema = z.object({
  id: z.uuid(),
  templateCode: z.string(),
  templateVersion: z.int(),
  category: z.enum(SMS_CATEGORIES),
  audience: z.enum(SMS_AUDIENCES),
  /** Masked, never the whole number on a page (rule 30 is logs; pages show as little). */
  mobileMasked: z.string(),
  segments: z.int(),
  costEstimateRial: z.string(),
  status: z.enum(SMS_DISPATCH_STATUSES),
  suppressedReason: z.string().nullable(),
  sendAfter: z.iso.datetime({ offset: true }),
  sentAt: z.iso.datetime({ offset: true }).nullable(),
  deliveryStatus: z.string().nullable(),
  /** Task 6-9: one SMS scheduled by staff (6-5), cancellable while it waits. */
  staffScheduled: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type SmsDispatchView = z.infer<typeof smsDispatchViewSchema>;

export const smsDispatchQuerySchema = z.object({
  status: z.enum(SMS_DISPATCH_STATUSES).optional(),
  templateCode: z.string().optional(),
});

export const smsConsentSchema = z.strictObject({
  mobile: z.string().min(10).max(14),
  action: z.enum(['consent', 'withdraw']),
  reason: z.string().trim().min(3).max(500),
});
