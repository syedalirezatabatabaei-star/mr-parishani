import * as z from 'zod';
import { mobileSchema } from './auth.js';

/**
 * ADR-052 (owner 1405/08/02): a financial signer's mobile is where their SMS codes go, so it is
 * changed only by two other people holding `identity.approve_financial_mobile_change` (the CEO
 * and the system administrator), never by its owner, and takes effect a set time after the
 * second approval (`identity.financial_step_up`, 24 hours); the old number is told.
 */
export const staffMobileChangeCreateSchema = z.object({
  accountId: z.uuid(),
  mobile: mobileSchema,
  reason: z.string().trim().min(3).max(500),
});

export const staffMobileChangeDecideSchema = z.object({
  outcome: z.enum(['approved', 'refused']),
  reason: z.string().trim().min(3).max(500).optional(),
});

export const staffMobileChangeViewSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  /** The new number's last four digits only. */
  mobileLastFour: z.string(),
  reason: z.string(),
  requestedBy: z.uuid(),
  requestedAt: z.iso.datetime({ offset: true }),
  approvedBy: z.array(z.uuid()),
  status: z.enum(['open', 'approved', 'refused', 'applied']),
  /** When an approved change takes effect (the second approval plus the delay). */
  effectiveAt: z.iso.datetime({ offset: true }).nullable(),
});
export type StaffMobileChangeView = z.infer<typeof staffMobileChangeViewSchema>;
