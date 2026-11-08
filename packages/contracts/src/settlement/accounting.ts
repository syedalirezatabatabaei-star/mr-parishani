import * as z from 'zod';
import { DISPUTE_STATUSES } from './disputes.js';

/**
 * The accounting panel's reports and the Odoo 19 export (task 5-7; doc 06 §7; doc 14 ث). The
 * export's date column is ISO for Odoo's import, a Jalali one beside it (owner, 5.5): data
 * exchanged, never shown on a page.
 */

const instant = z.iso.datetime({ offset: true });
const rial = z.string();

export const heldReportRowSchema = z.object({
  kind: z.enum(['credit_service', 'cash_fee']),
  itemId: z.uuid(),
  doctorId: z.uuid(),
  /** Not `doctorName` (the treatment class's name, doc 04 §4): no patient is in this row. */
  providerName: z.string(),
  amountRial: rial,
  dueAt: instant,
  disputeId: z.uuid().nullable(),
  disputeStatus: z.enum(DISPUTE_STATUSES).nullable(),
  openedAt: instant.nullable(),
});
export type HeldReportRow = z.infer<typeof heldReportRowSchema>;

export const negativeReportRowSchema = z.object({
  doctorId: z.uuid(),
  providerName: z.string(),
  periodYear: z.int(),
  periodMonth: z.int(),
  carriedOutRial: rial,
  /** Consecutive statements, up to the latest, that carried a balance. */
  periods: z.int(),
  /** periods ≥ settlement.negative_balance_alert_periods (configuration). */
  alert: z.boolean(),
});
export type NegativeReportRow = z.infer<typeof negativeReportRowSchema>;

export const odooMappingSchema = z.object({
  internalCode: z.string(),
  odooAccountCode: z.string(),
  reason: z.string(),
  setAt: instant,
});
export type OdooMapping = z.infer<typeof odooMappingSchema>;

export const setOdooMappingSchema = z.strictObject({
  internalCode: z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/),
  odooAccountCode: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(3).max(500),
});

export const odooExportRequestSchema = z.strictObject({
  year: z.int().min(1400).max(1500),
  month: z.int().min(1).max(12),
});

export const odooExportSchema = z.object({
  id: z.uuid(),
  periodYear: z.int(),
  periodMonth: z.int(),
  documents: z.int(),
  debitTotalRial: rial,
  creditTotalRial: rial,
  sha256: z.string(),
  generatedAt: instant,
  /** Only in the answer that makes it; the history lists the totals. */
  csv: z.string().optional(),
});
export type OdooExport = z.infer<typeof odooExportSchema>;
