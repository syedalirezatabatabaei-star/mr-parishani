import type {
  AppointmentStatus,
  CaseStatus,
  IntakeCategory,
  IntakeChannel,
} from '@sepehr/contracts';
import type { StatusTone } from '@sepehr/ui';

/** A case's status in words (docs/01), and the color it is shown in. */
export const CASE_STATUS: Readonly<
  Record<CaseStatus, { readonly label: string; readonly tone: StatusTone }>
> = {
  new: { label: 'تازه', tone: 'info' },
  advising: { label: 'در حال مشاوره', tone: 'accent' },
  appointment_booked: { label: 'نوبت گرفته', tone: 'accent' },
  examined: { label: 'معاینه‌شده', tone: 'accent' },
  proforma_issued: { label: 'پیش‌فاکتور صادرشده', tone: 'accent' },
  credit_requested: { label: 'درخواست اعتبار', tone: 'warning' },
  credit_decided: { label: 'تصمیم اعتباری', tone: 'warning' },
  contracted: { label: 'قرارداد', tone: 'success' },
  funded: { label: 'شارژشده', tone: 'success' },
  in_treatment: { label: 'در حال درمان', tone: 'success' },
  completed: { label: 'پایان‌یافته', tone: 'neutral' },
  cancelled: { label: 'بسته‌شده', tone: 'neutral' },
};

/** What an intake turned out to be (doc 05 §4). */
export const INTAKE_CATEGORY: Readonly<Record<IntakeCategory, string>> = {
  new: 'سرنخ تازه',
  duplicate_active: 'تکراری: پرونده باز دارد',
  returning: 'بازگشتی',
  existing_customer: 'مشتری فعلی',
  blocked: 'مسدود',
};

export const INTAKE_CHANNEL: Readonly<Record<IntakeChannel, string>> = {
  app: 'اپ',
  wordpress: 'سایت',
  excel: 'اکسل',
  advisor: 'مشاور',
};

/** An appointment's status in words (doc 08 §7), as the advisor reads it. */
export const APPOINTMENT_STATUS: Readonly<
  Record<AppointmentStatus, { readonly label: string; readonly tone: StatusTone }>
> = {
  held: { label: 'در حال انتخاب', tone: 'neutral' },
  requested: { label: 'در انتظار تأیید مرکز', tone: 'warning' },
  confirmed: { label: 'تأییدشده', tone: 'success' },
  checked_in: { label: 'پذیرش‌شده', tone: 'info' },
  examined: { label: 'انجام‌شده', tone: 'accent' },
  rejected: { label: 'ردشده', tone: 'danger' },
  expired: { label: 'منقضی', tone: 'neutral' },
  cancelled_by_patient: { label: 'لغو به‌دست بیمار', tone: 'neutral' },
  cancelled_by_center: { label: 'لغو به‌دست مرکز', tone: 'danger' },
  no_show: { label: 'عدم حضور', tone: 'danger' },
  rescheduled: { label: 'جابه‌جاشده', tone: 'neutral' },
};

/** A stored mobile (9XXXXXXXXX) as people dial it. */
export const dialMobile = (mobile: string) => `0${mobile}`;
