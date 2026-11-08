import type { PartnershipStatus } from '@sepehr/contracts';
import type { StatusTone } from '@sepehr/ui';

/** A partnership request's status as the queue shows it (owner 1405/08/10). */
export const PARTNERSHIP_STATUS: Readonly<
  Record<PartnershipStatus, { label: string; tone: StatusTone }>
> = {
  pending: { label: 'در انتظار بررسی', tone: 'warning' },
  reviewed: { label: 'تأیید اولیه؛ منتظر تأیید نهایی', tone: 'info' },
  approved: { label: 'تأییدشده', tone: 'success' },
  rejected: { label: 'ردشده', tone: 'danger' },
};

/** Each step of a request's history. */
export const PARTNERSHIP_EVENT: Readonly<Record<string, string>> = {
  received: 'درخواست رسید',
  center_created: 'مرکز به‌صورت پیش‌نویس ثبت شد',
  reviewed: 'تأیید اولیه کارشناس شبکه درمان',
  account_created: 'حساب مدیر مرکز ساخته شد',
  link_sent: 'پیوند ساخت رمز پیامک شد',
  approved: 'تأیید نهایی مدیر شبکه درمان',
  rejected: 'رد شد',
};
