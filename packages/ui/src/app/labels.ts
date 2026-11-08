import type {
  CenterStatus,
  DisputeStatus,
  PayoutStatus,
  ServiceAuthorizationStatus,
  StatementStatus,
} from '@sepehr/contracts';
import type { Tone as StatusTone } from '../kit/controls.js';

/** A center's status in words (doc 08 §3), and the color it is shown in. */
export const CENTER_STATUS: Readonly<Record<CenterStatus, { label: string; tone: StatusTone }>> = {
  draft: { label: 'پیش‌نویس', tone: 'neutral' },
  under_review: { label: 'در حال بررسی', tone: 'warning' },
  needs_fix: { label: 'نیازمند اصلاح', tone: 'danger' },
  active: { label: 'فعال', tone: 'success' },
  suspended: { label: 'تعلیق‌شده', tone: 'danger' },
  terminated: { label: 'پایان همکاری', tone: 'neutral' },
};

/** A service authorization's status in words (doc 12 §6; task 4-7). */
export const SERVICE_STATUS: Readonly<
  Record<ServiceAuthorizationStatus, { label: string; tone: StatusTone }>
> = {
  code_sent: { label: 'منتظر کد بیمار', tone: 'warning' },
  delivered: { label: 'ثبت‌شده، در انتظار قطعی شدن', tone: 'info' },
  finalized: { label: 'قطعی‌شده', tone: 'success' },
  expired: { label: 'منقضی‌شده', tone: 'neutral' },
  cancelled: { label: 'لغوشده', tone: 'neutral' },
  reversed: { label: 'برگشت‌خورده', tone: 'neutral' },
};

/** A doctor's statement's status in words (doc 06 §5; tasks 5-4 to 5-6). */
export const STATEMENT_STATUS: Readonly<
  Record<StatementStatus, { label: string; tone: StatusTone }>
> = {
  draft: { label: 'پیش‌نویس، در دست بررسی', tone: 'info' },
  reviewed: { label: 'بررسی‌شده', tone: 'info' },
  approved: { label: 'تأییدشده، در انتظار پرداخت', tone: 'warning' },
  paid: { label: 'پرداخت‌شده', tone: 'success' },
  cancelled: { label: 'لغوشده', tone: 'neutral' },
};

/** Where a financial dispute is (task 5-2). */
export const DISPUTE_STATUS: Readonly<Record<DisputeStatus, { label: string; tone: StatusTone }>> =
  {
    open: { label: 'باز، در دست بررسی', tone: 'warning' },
    resolved_accepted: { label: 'پذیرفته‌شده', tone: 'success' },
    resolved_rejected: { label: 'ردشده', tone: 'neutral' },
    accepted_pending_posting: { label: 'پذیرفته‌شده، در انتظار اصلاح', tone: 'info' },
  };

/** A payout order's status (task 5-5). */
export const PAYOUT_STATUS: Readonly<Record<PayoutStatus, { label: string; tone: StatusTone }>> = {
  issued: { label: 'صادرشده', tone: 'info' },
  sent_to_bank: { label: 'ارسال‌شده به بانک', tone: 'warning' },
  confirmed: { label: 'پرداخت‌شده', tone: 'success' },
  failed: { label: 'ناموفق', tone: 'danger' },
};
