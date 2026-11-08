import * as z from 'zod';
import { rialAmountSchema } from '../catalog/tariffs.js';
import { normalizeDigits } from '../text/digits.js';

/**
 * Physical deliveries and guarantee instruments (doc 12 §3; task 4-2): what reaches the
 * office (the signed contract, cheques, promissory notes, other documents), and each
 * cheque or note with its number encrypted (rule 27) and never shown beyond its last
 * four digits, logged or sent by SMS.
 */

export const DELIVERY_STATUSES = [
  'awaiting_send',
  'sent',
  'received',
  'verified',
  'incomplete',
  'returned',
  'archived',
  'released',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_METHODS = ['courier', 'post', 'in_person'] as const;
export const DELIVERY_ITEM_KINDS = [
  'signed_contract',
  'cheque',
  'promissory_note',
  'other',
] as const;
export const DELIVERY_ITEM_STATUSES = ['expected', 'received', 'missing'] as const;

export const INSTRUMENT_KINDS = ['cheque', 'promissory_note'] as const;
export const INSTRUMENT_STATUSES = [
  'received',
  'verified',
  'held',
  'released',
  'presented',
  'cleared',
  'bounced',
  'legal_action',
] as const;
export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number];

/** A cheque's Sayad number or a note's serial, as typed: any digits, spaces or dashes. */
export const instrumentNumberSchema = z
  .string()
  .transform((v) => normalizeDigits(v).replace(/[\s\-_/]/g, ''))
  .pipe(z.string().regex(/^[0-9A-Za-z]{6,24}$/));

const label = z.string().trim().min(2).max(120);
const reason = z.string().trim().min(3).max(500);

export const createDeliverySchema = z.strictObject({
  creditApplicationId: z.uuid(),
  items: z
    .array(z.strictObject({ kind: z.enum(DELIVERY_ITEM_KINDS), label }))
    .min(1)
    .max(30),
});

export const deliverySentSchema = z.strictObject({
  method: z.enum(DELIVERY_METHODS),
  trackingCode: z.string().trim().min(3).max(60).optional(),
});

export const deliveryReceivedSchema = z.strictObject({
  method: z.enum(DELIVERY_METHODS),
  trackingCode: z.string().trim().min(3).max(60).optional(),
});

export const deliveryItemSchema = z.strictObject({ status: z.enum(['received', 'missing']) });
export const deliveryArchiveSchema = z.strictObject({
  location: z.string().trim().min(2).max(120),
});
export const deliveryReturnSchema = z.strictObject({ reason });

export const registerInstrumentSchema = z.strictObject({
  itemId: z.uuid(),
  kind: z.enum(INSTRUMENT_KINDS),
  /** The borrower, or a guarantor of the application by id. */
  issuer: z.discriminatedUnion('role', [
    z.strictObject({ role: z.literal('borrower') }),
    z.strictObject({ role: z.literal('guarantor'), guarantorId: z.uuid() }),
  ]),
  amountRial: rialAmountSchema,
  /** Gregorian day (YYYY-MM-DD), entered in Jalali by the UI. */
  dueOn: z.iso.date().optional(),
  bankName: z.string().trim().min(2).max(80).optional(),
  number: instrumentNumberSchema,
  notes: z.string().trim().max(500).optional(),
});

export const instrumentSearchQuerySchema = z.object({ number: instrumentNumberSchema });

const instant = z.iso.datetime({ offset: true });
const rial = z.string().regex(/^\d+$/);

export const instrumentViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  deliveryId: z.uuid().nullable(),
  kind: z.enum(INSTRUMENT_KINDS),
  role: z.enum(['borrower', 'guarantor']),
  guarantorId: z.uuid().nullable(),
  amountRial: rial,
  dueOn: z.string().nullable(),
  bankName: z.string().nullable(),
  /** Only the last four characters are ever shown (rule 27). */
  numberLast4: z.string(),
  sayadConfirmed: z.boolean(),
  sayadConfirmedAt: instant.nullable(),
  status: z.enum(INSTRUMENT_STATUSES),
  createdAt: instant,
});
export type InstrumentView = z.infer<typeof instrumentViewSchema>;

export const deliveryViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  status: z.enum(DELIVERY_STATUSES),
  method: z.enum(DELIVERY_METHODS).nullable(),
  trackingCode: z.string().nullable(),
  receivedAt: instant.nullable(),
  archiveLocation: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(DELIVERY_ITEM_KINDS),
      label: z.string(),
      status: z.enum(DELIVERY_ITEM_STATUSES),
      instrumentId: z.uuid().nullable(),
    }),
  ),
  instruments: z.array(instrumentViewSchema),
  createdAt: instant,
});
export type DeliveryView = z.infer<typeof deliveryViewSchema>;

/** What the borrower or patient sees of a delivery: its state and what is missing. */
export const myDeliveryViewSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  status: z.enum(DELIVERY_STATUSES),
  method: z.enum(DELIVERY_METHODS).nullable(),
  items: z.array(
    z.object({ id: z.uuid(), label: z.string(), status: z.enum(DELIVERY_ITEM_STATUSES) }),
  ),
});

/** The owner's own instruments (task 6-9): the last four characters and the state only. */
export const myInstrumentSchema = z.object({
  id: z.uuid(),
  creditApplicationId: z.uuid(),
  kind: z.enum(INSTRUMENT_KINDS),
  role: z.enum(['borrower', 'guarantor']),
  amountRial: rial,
  dueOn: z.string().nullable(),
  numberLast4: z.string(),
  status: z.enum(INSTRUMENT_STATUSES),
});
export type MyInstrument = z.infer<typeof myInstrumentSchema>;

export const instrumentNumberViewSchema = z.object({ number: z.string() });

/** SMS: what is missing from a delivery, by item names only; never a number. */
export const instrumentSmsTemplatesSchema = z.object({
  deliveryIncomplete: z
    .string()
    .min(10)
    .max(400)
    .refine((t) => t.includes('{items}'), { message: 'needs {items}' }),
});
