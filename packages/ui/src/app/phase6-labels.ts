import type {
  CampaignExclusion,
  CampaignFilterCode,
  CampaignStatus,
  CollectionActionKind,
  CollectionTaskKind,
  CollectionTaskStatus,
  ExecutionStatus,
  InstrumentStatus,
  PaymentPromiseStatus,
  SmsCategory,
  SmsDispatchStatus,
} from '@sepehr/contracts';
import type { Tone as StatusTone } from '../kit/controls.js';

type Label = { readonly label: string; readonly tone: StatusTone };

/**
 * Phase 6's states in words (task 6-9; doc 15), and the color each is shown in. A state is
 * always written, never told by its color alone.
 */

/** An installment as the schedule computes it (task 6-1). */
export const INSTALLMENT_STATE: Readonly<
  Record<'scheduled' | 'due' | 'overdue' | 'partially_paid' | 'paid' | 'cancelled', Label>
> = {
  scheduled: { label: 'سررسید نشده', tone: 'neutral' },
  due: { label: 'سررسید امروز', tone: 'warning' },
  overdue: { label: 'معوق', tone: 'danger' },
  partially_paid: { label: 'بخشی پرداخت‌شده', tone: 'warning' },
  paid: { label: 'پرداخت‌شده', tone: 'success' },
  cancelled: { label: 'لغوشده', tone: 'neutral' },
};

/** A slip or payment (task 6-2). */
export const PAYMENT_STATE: Readonly<Record<'pending_approval' | 'approved' | 'rejected', Label>> =
  {
    pending_approval: { label: 'در انتظار تأیید مالی', tone: 'warning' },
    approved: { label: 'تأییدشده', tone: 'success' },
    rejected: { label: 'ردشده', tone: 'danger' },
  };

/** A cheque or note as its owner reads it (task 6-9): where it is, never its number. */
export const OWN_INSTRUMENT_STATE: Readonly<Record<InstrumentStatus, Label>> = {
  received: { label: 'دریافت‌شده', tone: 'info' },
  verified: { label: 'بررسی‌شده', tone: 'info' },
  held: { label: 'نزد سپهر', tone: 'neutral' },
  released: { label: 'آزادشده، آماده تحویل به شما', tone: 'success' },
  presented: { label: 'ارائه‌شده به بانک', tone: 'warning' },
  cleared: { label: 'وصول‌شده', tone: 'neutral' },
  bounced: { label: 'برگشتی', tone: 'danger' },
  legal_action: { label: 'در پیگیری حقوقی', tone: 'danger' },
};

/** A cheque's execution (task 6-8). */
export const EXECUTION_STATE: Readonly<Record<ExecutionStatus, Label>> = {
  proposed: { label: 'پیشنهادشده، در انتظار تأیید', tone: 'warning' },
  presented: { label: 'ارائه‌شده به بانک', tone: 'info' },
  cleared: { label: 'وصول‌شده', tone: 'success' },
  bounced: { label: 'برگشتی', tone: 'danger' },
  rejected: { label: 'ردشده', tone: 'neutral' },
};

export const PROMISE_STATE: Readonly<Record<PaymentPromiseStatus, Label>> = {
  open: { label: 'باز', tone: 'info' },
  kept: { label: 'عمل‌شده', tone: 'success' },
  broken: { label: 'شکسته', tone: 'danger' },
  cancelled: { label: 'لغوشده', tone: 'neutral' },
};

export const TASK_KIND: Readonly<Record<CollectionTaskKind, string>> = {
  call: 'تماس (مرحله ۱)',
  guarantor_notice: 'اطلاع به ضامن (مرحله ۲)',
  suggest_cheque: 'پیشنهاد اجرای چک (مرحله ۳)',
  legal_referral: 'ارجاع حقوقی (مرحله ۴)',
  promise_broken: 'وعده شکسته',
};

export const TASK_STATE: Readonly<Record<CollectionTaskStatus, Label>> = {
  open: { label: 'باز', tone: 'warning' },
  proposed: { label: 'پیشنهادشده، در انتظار مدیر وصول', tone: 'info' },
  done: { label: 'انجام‌شده', tone: 'success' },
  dismissed: { label: 'کنار گذاشته', tone: 'neutral' },
};

export const ACTION_KIND: Readonly<Record<CollectionActionKind, string>> = {
  call: 'تماس',
  sms: 'پیامک',
  visit: 'مراجعه',
  letter: 'نامه',
  guarantor_contact: 'تماس با ضامن',
  legal_referral: 'ارجاع حقوقی',
};

/**
 * An action's outcome is the agent's own words, except where the system records the action
 * itself (task 6-7: the guarantor's SMS): those codes are shown in words.
 */
const SYSTEM_OUTCOME: Readonly<Record<string, string>> = { sms_sent: 'پیامک فرستاده شد' };
export const actionOutcome = (outcome: string): string => SYSTEM_OUTCOME[outcome] ?? outcome;

export const CAMPAIGN_STATE: Readonly<Record<CampaignStatus, Label>> = {
  draft: { label: 'پیش‌نویس، در انتظار تأیید نفر دوم', tone: 'warning' },
  sending: { label: 'در حال ارسال', tone: 'info' },
  paused: { label: 'متوقف موقت', tone: 'warning' },
  stopped: { label: 'متوقف', tone: 'danger' },
  completed: { label: 'پایان‌یافته', tone: 'success' },
  cancelled: { label: 'لغوشده', tone: 'neutral' },
};

export const CAMPAIGN_FILTER: Readonly<Record<CampaignFilterCode, string>> = {
  borrowers_overdue_at_least: 'وام‌گیرندگان معوق، دست‌کم چند روز',
  borrowers_active: 'وام‌گیرندگان دارای قسط باز',
  guarantors_overdue_at_least: 'ضامن‌های وام‌های معوق، دست‌کم چند روز',
  patients_of_center: 'بیماران یک یا چند محل کار پزشک',
};

export const CAMPAIGN_EXCLUSION: Readonly<Record<CampaignExclusion, string>> = {
  no_mobile: 'بی‌موبایل',
  held: 'فوت یا ازکارافتادگی',
  no_consent: 'بی‌رضایت (تبلیغاتی)',
  unsubscribed: 'لغو اشتراک (تبلیغاتی)',
  duplicate_mobile: 'موبایل تکراری',
};

export const SMS_CATEGORY: Readonly<Record<SmsCategory, string>> = {
  transactional: 'خدماتی و اطلاع‌رسانی',
  promotional: 'تبلیغاتی',
  urgent: 'فوری (کد ورود و خدمت)',
};

export const DISPATCH_STATE: Readonly<Record<SmsDispatchStatus, Label>> = {
  pending: { label: 'در صف ارسال', tone: 'info' },
  scheduled: { label: 'زمان‌بندی‌شده', tone: 'info' },
  sent: { label: 'ارسال‌شده', tone: 'success' },
  delivered: { label: 'تحویل‌شده', tone: 'success' },
  failed: { label: 'ناموفق', tone: 'danger' },
  suppressed: { label: 'ارسال‌نشده (بی‌رضایت)', tone: 'neutral' },
  cancelled: { label: 'لغوشده', tone: 'neutral' },
};
