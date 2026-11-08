import * as z from 'zod';
import type { PermissionCode } from '../access/permissions.js';

/**
 * ADR-052 (owner 1405/08/02): every financial approval, and the request before it, is confirmed
 * with a one-time SMS code bound to that one operation. The operations a code can be for, with
 * the words the SMS uses for each (Kavenegar's token10; never a patient's name).
 */
export const STEP_UP_OPERATIONS = {
  funding: 'شارژ کیف اعتبار',
  special_operation: 'عملیات ویژه کیف',
  doctor_change: 'تغییر پزشک کیف',
  credit_transfer: 'انتقال اعتبار',
  credit_cancellation: 'انصراف پرونده',
  penalty_override: 'نرخ خسارت پرونده',
  refund_payment: 'پرداخت استرداد',
  completion_receipt: 'تأیید فیش تکمیل',
  installment_payment: 'تأیید فیش قسط',
  cash_service: 'خدمت نقدی',
  statement_approval: 'تأیید صورت‌وضعیت',
  statement_cancellation: 'لغو صورت‌وضعیت',
  payout_export: 'فایل پرداخت تسویه',
  payout_confirmation: 'تأیید پرداخت تسویه',
  dispute_resolution: 'حل اختلاف تسویه',
  instrument_execution: 'اجرای چک',
  instrument_release: 'آزادسازی چک یا سفته',
  bank_account_change: 'تغییر شبای مرکز',
  credit_decision: 'تأیید مبلغ اعتبار',
  cost_split_review: 'بازبینی تفکیک دستمزد',
  financial_config: 'تنظیم مالی',
  visit_tariff: 'تعرفه ویزیت',
  holidays: 'تعطیلات و سررسیدها',
  patient_mobile: 'تغییر شماره بیمار',
  lead_mobile: 'تأیید شماره سرنخ',
  approver_mobile: 'تغییر شماره تأییدکننده',
  totp_reset: 'بازنشانی ورود دومرحله‌ای',
} as const;

export type StepUpOperationType = keyof typeof STEP_UP_OPERATIONS;

export const stepUpOperationTypeSchema = z.enum(
  Object.keys(STEP_UP_OPERATIONS) as [StepUpOperationType, ...StepUpOperationType[]],
);

/** Which signature of the operation: the request (first person) or the approval (second). */
export const stepUpStepSchema = z.enum(['request', 'approve']);

/**
 * What one code is for. `id` is the record the action is on (a request, a receipt, a statement;
 * for a request not yet made, what it is about). `amountRial`: whole rials as digits, or null.
 */
export const stepUpOperationSchema = z.strictObject({
  type: stepUpOperationTypeSchema,
  id: z.uuid(),
  amountRial: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,17})$/)
    .nullable(),
  step: stepUpStepSchema,
});
export type StepUpOperation = z.infer<typeof stepUpOperationSchema>;

/** `POST /identity/step-up/challenges`: sends the code to the caller's own verified mobile. */
export const stepUpChallengeViewSchema = z.object({
  challengeId: z.uuid(),
  /** The mobile it went to, masked: 912***4567. */
  maskedMobile: z.string(),
  expiresInSeconds: z.int(),
  resendAfterSeconds: z.int(),
});
export type StepUpChallengeView = z.infer<typeof stepUpChallengeViewSchema>;

/** The header a confirmed request carries: `<challengeId>.<code>`. */
export const STEP_UP_HEADER = 'x-step-up';

export function parseStepUpHeader(value: unknown): { challengeId: string; code: string } | null {
  if (typeof value !== 'string') return null;
  const m = /^([0-9a-f-]{36})\.(\d{6})$/i.exec(value.trim());
  if (!m) return null;
  const challengeId = m[1] ?? '';
  return z.uuid().safeParse(challengeId).success ? { challengeId, code: m[2] ?? '' } : null;
}

/**
 * ADR-052 (owner 1405/08/03): the permissions whose requests or approvals are signed with an
 * SMS code. A staff member holding any of them is a financial signer: their mobile is where
 * the codes go, so its first number and every change are approved by two others (the CEO and
 * the system administrator), never through the self-service page; the launch check counts
 * signers without one. Center accounts (reception, doctor) are not signers.
 */
export const FINANCIAL_SIGNING_PERMISSIONS = [
  'catalog.manage_centers',
  'catalog.manage_visit_tariffs',
  'config.manage_business',
  'config.manage_holidays',
  'config.approve_holidays',
  'contract.request_refund_payment',
  'contract.approve_refund_payment',
  'credit.propose_decision',
  'credit.decide_manager',
  'credit.decide_out_of_matrix',
  'credit.decide_second_check',
  'credit.review_cost_split',
  'credit.request_cancellation',
  'credit.approve_cancellation',
  'credit.request_penalty_override',
  'credit.approve_penalty_override',
  'identity.request_financial_mobile_change',
  'identity.approve_financial_mobile_change',
  'identity.request_totp_reset',
  'identity.approve_totp_reset',
  'identity.change_patient_mobile',
  'instrument.propose_execution',
  'instrument.approve_execution_collection',
  'instrument.approve_execution_finance',
  'instrument.request_release',
  'instrument.approve_release',
  'lead.approve_person_mobile',
  'repayment.approve_payment',
  'settlement.approve',
  'settlement.review_statement',
  'settlement.cancel_statement',
  'settlement.export_payouts',
  'settlement.resolve_dispute',
  'settlement.record_cash_service',
  'settlement.confirm_cash_service',
  'wallet.request_funding',
  'wallet.approve_funding',
  'wallet.request_special_operation',
  'wallet.approve_special_operation',
  'wallet.request_doctor_change',
  'wallet.approve_doctor_change',
  'wallet.request_credit_transfer',
  'wallet.approve_credit_transfer',
] as const satisfies readonly PermissionCode[];
