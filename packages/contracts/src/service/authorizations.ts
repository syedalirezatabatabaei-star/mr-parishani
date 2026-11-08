import * as z from 'zod';

/**
 * Service authorization and delivery (doc 12 §6; task 4-6 [financial]). The doctor (or a
 * delegated secretary) authorizes proforma lines against a funded purse, which reserves
 * them on the purse's memo chain; the borrower's SMS code records the service; it is final
 * after `service.finalize_after_hours`. Amounts are whole rials as text (rule 1).
 */

export const SERVICE_AUTHORIZATION_STATUSES = [
  'code_sent',
  'delivered',
  'finalized',
  'expired',
  'cancelled',
  /** Final once, then taken back by an accepted dispute on its payable (task 5-2b). */
  'reversed',
] as const;
export type ServiceAuthorizationStatus = (typeof SERVICE_AUTHORIZATION_STATUSES)[number];

/** The six digits of a service code, any digit script (rule 23 normalizes before checking). */
export const SERVICE_CODE_FORMAT = /^\d{6}$/;

export const issueServiceAuthorizationSchema = z.strictObject({
  purseId: z.uuid(),
  /** Lines of the purse's own proforma; each in one live authorization only (owner, پ۷). */
  proformaLineIds: z
    .array(z.uuid())
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'repeated line' }),
});

export const deliverServiceSchema = z.strictObject({ code: z.string().trim().min(1).max(20) });
export const cancelServiceAuthorizationSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});
export const serviceAuthorizationQuerySchema = z.object({
  purseId: z.uuid().optional(),
  status: z.enum(SERVICE_AUTHORIZATION_STATUSES).optional(),
});

const instant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

export const serviceAuthorizationViewSchema = z.object({
  id: z.uuid(),
  purseId: z.uuid(),
  creditApplicationId: z.uuid(),
  workplaceId: z.uuid(),
  status: z.enum(SERVICE_AUTHORIZATION_STATUSES),
  /** What the doctor authorized: the sum of its lines. */
  amountRial: rial,
  lines: z.array(z.object({ proformaLineId: z.uuid(), amountRial: rial })),
  issuedAt: instant,
  expiresAt: instant,
  deliveredAt: instant.nullable(),
  finalizeDueAt: instant.nullable(),
  finalizedAt: instant.nullable(),
  cancelledAt: instant.nullable(),
  cancelReason: z.string().nullable(),
  attemptsLeft: z.int().min(0),
  sendsLeft: z.int().min(0),
});
export type ServiceAuthorizationView = z.infer<typeof serviceAuthorizationViewSchema>;

/**
 * A funded patient referred to the doctor (owner, پ۲): the name and whether a service can
 * be authorized now; no amount, balance or score.
 */
export const doctorPatientViewSchema = z.object({
  purseId: z.uuid(),
  creditApplicationId: z.uuid(),
  patientName: z.string().nullable(),
  /** The AuthorizedRecipient who now receives the codes (task 4-8): a name only; absent without one. */
  recipientName: z.string().optional(),
  allowed: z.boolean(),
});
export type DoctorPatientView = z.infer<typeof doctorPatientViewSchema>;

/** The borrower's own authorizations: what was authorized, and when. */
export const myServiceAuthorizationViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  status: z.enum(SERVICE_AUTHORIZATION_STATUSES),
  amountRial: rial,
  centerName: z.string().nullable(),
  issuedAt: instant,
  deliveredAt: instant.nullable(),
  finalizedAt: instant.nullable(),
});
export type MyServiceAuthorizationView = z.infer<typeof myServiceAuthorizationViewSchema>;

/**
 * The service code's SMS (doc 12 §6.3): the code, the amount and the center's name, never
 * what the treatment is (doc 12 §9 test 10).
 */
export const serviceSmsTemplatesSchema = z.object({
  code: z
    .string()
    .min(10)
    .max(400)
    .refine((t) => t.includes('{code}') && t.includes('{amount}'), {
      message: 'needs {code} and {amount}',
    })
    .refine((t) => !/\{service\}|\{treatment\}|\{lines\}/.test(t), {
      message: 'the code SMS names no treatment',
    }),
});

/**
 * The proforma lines a doctor may authorize on one purse (task 4-7): each line's service,
 * quantity and amount, and whether a live authorization already holds it (owner, پ۷). The
 * purse's balance is not here (owner, پ۲).
 */
export const doctorPurseLinesViewSchema = z.object({
  purseId: z.uuid(),
  patientName: z.string().nullable(),
  allowed: z.boolean(),
  lines: z.array(
    z.object({
      id: z.uuid(),
      lineNo: z.int().positive(),
      serviceName: z.string(),
      quantity: z.int().positive(),
      amountRial: z.string().regex(/^\d+$/),
      authorized: z.boolean(),
      /** ADR-050: materials of a wage-only loan, paid to the doctor in cash, never from the purse. */
      cashOnly: z.boolean(),
    }),
  ),
});
export type DoctorPurseLinesView = z.infer<typeof doctorPurseLinesViewSchema>;
