import * as z from 'zod';
import { INSTALLMENT_STATES } from './mine.js';

/**
 * What accounting's repayment routes answer (task 1-3, 6-2). Owner 1405/07/26: the schemas
 * only describe; nothing in repayment changed. Amounts are strings of rials.
 */
const rial = z.string().regex(/^\d+$/);
const instant = z.iso.datetime({ offset: true });

export const installmentScheduleViewSchema = z.object({
  id: z.uuid(),
  caseId: z.uuid(),
  purseId: z.uuid(),
  principalRial: rial,
  planFeeRial: rial,
  totalRial: rial,
  fundedAt: instant,
  roundingUnitRial: rial,
  paidRial: rial,
  outstandingRial: rial,
  unallocatedRial: rial,
  installments: z.array(
    z.object({
      id: z.uuid(),
      index: z.int().min(1),
      dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      amountRial: rial,
      paidRial: rial,
      outstandingRial: rial,
      status: z.enum(INSTALLMENT_STATES),
    }),
  ),
});
export type InstallmentScheduleView = z.infer<typeof installmentScheduleViewSchema>;

/** A payment approved or rejected: what was allocated to which installment. */
export const paymentDecisionSchema = z.object({
  paymentId: z.uuid(),
  status: z.enum(['approved', 'rejected']),
  allocatedRial: rial,
  surplusRial: rial,
  allocations: z.array(z.object({ installmentId: z.uuid(), amountRial: rial })),
});
export type PaymentDecisionView = z.infer<typeof paymentDecisionSchema>;
