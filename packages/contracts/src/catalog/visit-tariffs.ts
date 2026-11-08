import * as z from 'zod';
import { normalizePersianText } from '../text/persian.js';
import { tariffPricingSchema } from './tariffs.js';

/**
 * A doctor's visit price from the internal panel, by two people (owner 1405/07/29, answer i):
 * one proposes it for a workplace, another approves it, which writes the visit's tariff
 * version the catalog way (ADR-024), or rejects it. No ledger row: the visit is paid at the
 * center.
 */

export const VISIT_TARIFF_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type VisitTariffProposalStatus = (typeof VISIT_TARIFF_PROPOSAL_STATUSES)[number];

const reason = z.string().transform(normalizePersianText).pipe(z.string().min(3).max(500));

export const proposeVisitTariffSchema = z.strictObject({
  workplaceId: z.uuid(),
  pricing: tariffPricingSchema,
  /** From this moment (from the approval if omitted); never in the past when approved. */
  effectiveAt: z.iso.datetime({ offset: true }).optional(),
  reason,
});
export type ProposeVisitTariff = z.input<typeof proposeVisitTariffSchema>;

export const decideVisitTariffSchema = z.strictObject({ reason });
export type DecideVisitTariff = z.input<typeof decideVisitTariffSchema>;

export const visitTariffProposalListQuerySchema = z.object({
  status: z.enum(VISIT_TARIFF_PROPOSAL_STATUSES).optional(),
});

const instant = z.iso.datetime({ offset: true });

export const visitTariffProposalViewSchema = z.object({
  id: z.uuid(),
  workplaceId: z.uuid(),
  /** As GET /catalog/workplaces names it (a catalog fact, no patient in it). */
  doctor: z.object({ id: z.uuid(), name: z.string() }),
  /** The center's name; null for a private practice. */
  placeName: z.string().nullable(),
  cityCode: z.string(),
  isFree: z.boolean(),
  minAmountRial: z.string(),
  maxAmountRial: z.string(),
  effectiveAt: instant.nullable(),
  reason: z.string(),
  status: z.enum(VISIT_TARIFF_PROPOSAL_STATUSES),
  requestedAt: instant,
  /** A proposal is never decided by who made it. */
  requestedByMe: z.boolean(),
  decidedAt: instant.nullable(),
  decisionReason: z.string().nullable(),
  tariffVersionId: z.uuid().nullable(),
});
export type VisitTariffProposalView = z.infer<typeof visitTariffProposalViewSchema>;
export const visitTariffProposalListSchema = z.array(visitTariffProposalViewSchema);
