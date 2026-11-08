import * as z from 'zod';

/**
 * A credit purse as accounting and the auditor read it (task 1-2). Owner 1405/07/26: the
 * schema only describes; nothing in the wallet changed. Amounts are strings of rials.
 */
const rial = z.string().regex(/^\d+$/);

export const purseViewSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  status: z.enum(['approved', 'funded', 'closed']),
  approvedAmountRial: rial,
  fundedAt: z.iso.datetime({ offset: true }).nullable(),
  scope: z.object({
    centerNodeId: z.uuid(),
    doctorNodeId: z.uuid(),
    treatmentFieldCode: z.string(),
  }),
  balances: z.object({
    approvedRial: rial,
    availableRial: rial,
    reservedRial: rial,
    consumedPendingRial: rial,
    borrowerDebtRial: rial,
  }),
  reservations: z.array(
    z.object({
      authorizationId: z.uuid(),
      doctorNodeId: z.uuid(),
      reservedRial: rial,
      openRial: rial,
      pendingRial: rial,
      finalizedRial: rial,
      held: z.boolean(),
    }),
  ),
});
export type PurseView = z.infer<typeof purseViewSchema>;
