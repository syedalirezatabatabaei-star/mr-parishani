import type { CreditApplicationStatus, CreditQueue, DecisionAuthority } from '@sepehr/contracts';
import type { StatusTone } from '@sepehr/ui';

type Label = { readonly label: string; readonly tone: StatusTone };

/** A credit application's status for the credit units (doc 10 §4). */
export const CREDIT_STATUS: Readonly<Record<CreditApplicationStatus, Label>> = {
  draft: { label: 'پیش‌نویس', tone: 'neutral' },
  incomplete: { label: 'تکمیل پرونده', tone: 'warning' },
  ready_for_review: { label: 'آماده بررسی', tone: 'info' },
  scoring: { label: 'امتیازدهی', tone: 'info' },
  manual_review: { label: 'در انتظار تصمیم', tone: 'accent' },
  approved: { label: 'تأییدشده', tone: 'success' },
  conditional: { label: 'تأیید شرطی', tone: 'success' },
  rejected: { label: 'ردشده', tone: 'danger' },
  expired: { label: 'منقضی', tone: 'neutral' },
};

export const QUEUE_LABEL: Readonly<Record<CreditQueue, string>> = {
  completion: 'تکمیل پرونده',
  credit: 'اعتبار',
  committee: 'کمیته',
};

/** Who decides (doc 03 §6), as the engine names it. */
export const AUTHORITY_LABEL: Readonly<Record<DecisionAuthority, string>> = {
  expert_second_check: 'کارشناس اعتبار + کنترل دوم',
  credit_manager: 'مسئول / مدیر اعتبار',
  committee: 'کمیته ریسک و اعتبار',
  reject_no_override: 'رد؛ بدون اختیار عبور فردی',
};

export const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  approved: 'تأیید',
  conditional: 'تأیید شرطی',
  rejected: 'رد',
  needs_more_guarantors: 'نیاز به ضامن بیشتر',
};

export const DECISION_STATE: Readonly<Record<string, Label>> = {
  proposed: { label: 'پیشنهادشده', tone: 'warning' },
  decided: { label: 'نهایی', tone: 'success' },
  refused: { label: 'ردِ پیشنهاد', tone: 'danger' },
  withdrawn: { label: 'پس‌گرفته', tone: 'neutral' },
};
