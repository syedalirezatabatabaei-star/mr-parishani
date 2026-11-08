import * as z from 'zod';
import { normalizeDigits } from '../text/digits.js';
import { normalizePersianText } from '../text/persian.js';

/**
 * The catalog (task 2-4, doc 08 §4): treatment fields, the services under them, and the
 * tariffs of doctors' workplaces and centers. Amounts are whole rials, carried as decimal
 * strings on the wire and as `bigint` everywhere else (rule 1); tomans exist only in the UI.
 */

const code = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const text = (min: number, max: number) =>
  z.string().transform(normalizePersianText).pipe(z.string().min(min).max(max));
const reason = text(3, 500);

/** The one special service for a visit, in no field (task 2-4 decision). */
export const VISIT_SERVICE_CODE = 'visit';

// --- fields and services (the network manager, the system admin) ------------------------

export const createTreatmentFieldSchema = z.object({
  code,
  name: text(2, 100),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  reason,
});
export type CreateTreatmentField = z.input<typeof createTreatmentFieldSchema>;

export const updateTreatmentFieldSchema = z.object({
  name: text(2, 100).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  reason,
});
export type UpdateTreatmentField = z.input<typeof updateTreatmentFieldSchema>;

/**
 * ADR-050: what a service's price is: the doctor's wage, or materials. A loan on the wage only
 * finances its wage lines; the materials are paid to the doctor in cash. Default: wage (every
 * service before ADR-050). A change acts on later drafts only; an issued proforma keeps its own.
 */
export const COST_KINDS = ['wage', 'material'] as const;
export type CostKind = (typeof COST_KINDS)[number];

export const createServiceSchema = z.object({
  fieldCode: code,
  code,
  name: text(2, 200),
  costKind: z.enum(COST_KINDS).optional(),
  reason,
});
export type CreateService = z.input<typeof createServiceSchema>;

export const updateServiceSchema = z.object({
  name: text(2, 200).optional(),
  costKind: z.enum(COST_KINDS).optional(),
  reason,
});
export type UpdateService = z.input<typeof updateServiceSchema>;

/** Retiring a field or a service: a soft delete; its code is never reused. */
export const retireCatalogItemSchema = z.object({ reason });
export type RetireCatalogItem = z.input<typeof retireCatalogItemSchema>;

// --- tariffs -------------------------------------------------------------------------------

/**
 * Whole rials as a decimal string (Persian digits accepted), at most 18 digits so it fits
 * a Postgres bigint. Never a JS number, so no amount loses precision.
 */
export const rialAmountSchema = z
  .string()
  .transform(normalizeDigits)
  .pipe(z.string().regex(/^(0|[1-9][0-9]{0,17})$/))
  .transform((v) => BigInt(v));

/** Whose price: a doctor at one workplace, or a center. */
export const tariffOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workplace'), workplaceId: z.uuid() }),
  z.object({ kind: z.literal('center'), centerId: z.uuid() }),
]);
export type TariffOwner = z.input<typeof tariffOwnerSchema>;

/** Free (the visit only, checked by the service and the database) or a price range. */
export const tariffPricingSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('free') }),
    z.object({ kind: z.literal('range'), minRial: rialAmountSchema, maxRial: rialAmountSchema }),
  ])
  .refine((p) => p.kind === 'free' || (p.minRial > 0n && p.maxRial >= p.minRial), {
    message: 'a price range needs 0 < min <= max',
  });

/**
 * A new price from `effectiveAt` (now if omitted; never in the past). Earlier versions and
 * whatever was quoted from them do not change (doc 08 §4).
 */
export const setTariffSchema = z.object({
  owner: tariffOwnerSchema,
  serviceCode: code,
  pricing: tariffPricingSchema,
  effectiveAt: z.iso.datetime({ offset: true }).optional(),
  reason,
});
export type SetTariff = z.input<typeof setTariffSchema>;

/** The service is no longer offered by this owner from `effectiveAt` on. */
export const withdrawTariffSchema = z.object({
  effectiveAt: z.iso.datetime({ offset: true }).optional(),
  reason,
});
export type WithdrawTariff = z.input<typeof withdrawTariffSchema>;

/** Only a version that has not started yet may be cancelled (task 2-4 decision). */
export const cancelTariffVersionSchema = z.object({ reason });
export type CancelTariffVersion = z.input<typeof cancelTariffVersionSchema>;

export const tariffListQuerySchema = z
  .object({ workplaceId: z.uuid().optional(), centerId: z.uuid().optional() })
  .refine((q) => (q.workplaceId === undefined) !== (q.centerId === undefined), {
    message: 'exactly one of workplaceId and centerId',
  });
export type TariffListQuery = z.input<typeof tariffListQuerySchema>;

/** The price of a service at a workplace at a moment (now if omitted). */
export const tariffQuoteQuerySchema = z.object({
  serviceCode: code,
  at: z.iso.datetime({ offset: true }).optional(),
});
export type TariffQuoteQuery = z.input<typeof tariffQuoteQuerySchema>;

/** One treatment field: `POST` and `PATCH /catalog/fields`. */
export const treatmentFieldViewSchema = z.object({
  code: z.string(),
  name: z.string(),
  sortOrder: z.int(),
});
/** `GET /catalog/fields` (public): the treatment fields in their display order. */
export const treatmentFieldListSchema = z.array(treatmentFieldViewSchema);

/** One service: `POST` and `PATCH /catalog/services`. */
export const serviceViewSchema = z.object({
  code: z.string(),
  name: z.string(),
  kind: z.enum(['standard', 'visit']),
  /** ADR-050: the doctor's wage or materials. */
  costKind: z.enum(COST_KINDS),
  /** Null for the visit, which belongs to no field. */
  fieldCode: z.string().nullable(),
});
/** `GET /catalog/services` (public): the visit first, then each field's services. */
export const serviceListSchema = z.array(serviceViewSchema);

/** `POST /catalog/{fields,services}/:code/retire`. */
export const catalogItemRetiredSchema = z.object({ retired: z.literal(true) });

// --- answers (task 2-11: the center panel's services and prices) -------------------------

const isoInstant = z.iso.datetime({ offset: true });
const rialText = z.string().regex(/^\d+$/);

/** One version of a price (rials as strings; null amounts for a withdrawal). */
export const tariffVersionViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(['offered', 'withdrawn']),
  isFree: z.boolean(),
  minAmountRial: rialText.nullable(),
  maxAmountRial: rialText.nullable(),
  effectiveAt: isoInstant,
  reason: z.string(),
  cancelledAt: isoInstant.nullable(),
  createdAt: isoInstant,
});

/** A service's price at one owner: the version in force and those still to come. */
export const tariffViewSchema = z.object({
  id: z.uuid(),
  serviceCode: z.string(),
  owner: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('workplace'), workplaceId: z.uuid() }),
    z.object({ kind: z.literal('center'), centerId: z.uuid() }),
  ]),
  current: tariffVersionViewSchema.nullable(),
  upcoming: z.array(tariffVersionViewSchema),
});
export const tariffListSchema = z.array(tariffViewSchema);
/** `GET /catalog/tariffs/:id`: the tariff with every version, cancelled ones too. */
export const tariffDetailSchema = tariffViewSchema.extend({
  history: z.array(tariffVersionViewSchema),
});
/** `GET /catalog/workplaces/:id/quote`: the price in force, or null when nothing is offered. */
export const tariffQuoteViewSchema = z.object({
  quote: z
    .object({
      tariffVersionId: z.uuid(),
      tariffId: z.uuid(),
      source: z.enum(['workplace', 'center']),
      serviceId: z.uuid(),
      serviceCode: z.string(),
      isFree: z.boolean(),
      minAmountRial: rialText,
      maxAmountRial: rialText,
      effectiveAt: isoInstant,
    })
    .nullable(),
});
export type TariffViewBody = z.infer<typeof tariffViewSchema>;

/** A price an Excel batch proposed for a center (task 2-9 decision 2), until applied. */
export const proposedTariffListSchema = z.array(
  z.looseObject({
    rowId: z.uuid(),
    batchId: z.uuid(),
    owner: z.enum(['workplace', 'center']),
    serviceCode: z.string(),
    pricing: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('free') }),
      z.object({ kind: z.literal('range'), minRial: rialText, maxRial: rialText }),
    ]),
  }),
);

/** What applying the proposed prices did to each row. */
export const proposedTariffResultSchema = z.array(
  z.object({
    rowId: z.uuid(),
    status: z.enum(['applied', 'proposed', 'failed']),
    failure: z.string().optional(),
  }),
);
