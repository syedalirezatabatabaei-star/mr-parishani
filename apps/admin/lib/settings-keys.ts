import type { PermissionCode } from '@sepehr/contracts';

export interface SettingKey {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  /** Who may propose and decide (the API checks the key's category itself, rule 12). */
  readonly manage: PermissionCode;
  /** An on/off flag: the value is a boolean, or `{ enabled }`. */
  readonly flag?: 'boolean' | 'enabled';
}

const TECH: PermissionCode = 'config.manage_technical';
const BUSINESS: PermissionCode = 'config.manage_business';

/** The keys of this page (owner 1405/07/24, م۱۰). Every one is sensitive: two people. */
export const SETTING_KEYS: readonly [SettingKey, ...SettingKey[]] = [
  {
    group: 'هویت',
    key: 'identity.reauth',
    label: 'بازاحراز TOTP پیش از کار حساس',
    manage: TECH,
    flag: 'enabled',
  },
  {
    group: 'هویت',
    key: 'identity.factor_change_sms',
    label: 'پیامک تغییر عامل ورود',
    manage: TECH,
    flag: 'enabled',
  },
  {
    group: 'هویت',
    key: 'identity.financial_step_up',
    label: 'کد پیامکی امضای مالی',
    manage: TECH,
    flag: 'enabled',
  },
  {
    group: 'هویت',
    key: 'identity.staff_mobile_required',
    label: 'موبایل تأییدشده برای کارکنان',
    manage: TECH,
    flag: 'enabled',
  },
  { group: 'هویت', key: 'identity.session', label: 'عمر نشست و توکن', manage: TECH },
  { group: 'هویت', key: 'identity.otp', label: 'کد یک‌بارمصرف و محدودیت ارسال', manage: TECH },
  { group: 'هویت', key: 'identity.staff_login', label: 'ورود کارکنان', manage: TECH },
  { group: 'هویت', key: 'identity.lockout', label: 'قفل پس از تلاش ناموفق', manage: TECH },
  { group: 'هویت', key: 'identity.public_rate_limit', label: 'محدودیت نرخ عمومی', manage: TECH },
  {
    group: 'سرنخ',
    key: 'lead.excel_import_enabled',
    label: 'ورود سرنخ از اکسل',
    manage: TECH,
    flag: 'boolean',
  },
  {
    group: 'سرنخ',
    key: 'lead.returning_to_previous_agent',
    label: 'بازگشتی به مشاور قبلی',
    manage: BUSINESS,
    flag: 'boolean',
  },
  {
    group: 'سرنخ',
    key: 'lead.duplicate_window_days',
    label: 'پنجره تکراری (روز)',
    manage: BUSINESS,
  },
  {
    group: 'سرنخ',
    key: 'lead.person_mobile_pending_days',
    label: 'مهلت تأیید موبایل افزوده (روز)',
    manage: BUSINESS,
  },
  { group: 'سرنخ', key: 'lead.webhook_policy', label: 'فرم وردپرس: مهلت و محدودیت', manage: TECH },
  {
    group: 'نوبت',
    key: 'booking.default_approval_mode',
    label: 'حالت پیش‌فرض تأیید نوبت',
    manage: BUSINESS,
  },
  { group: 'نوبت', key: 'booking.booking_horizon_days', label: 'افق نوبت (روز)', manage: BUSINESS },
  { group: 'نوبت', key: 'booking.hold_minutes', label: 'نگه‌داشتن زمان (دقیقه)', manage: BUSINESS },
  {
    group: 'نوبت',
    key: 'booking.reminder_offsets_minutes',
    label: 'یادآوری‌ها (دقیقه پیش از نوبت)',
    manage: BUSINESS,
  },
  {
    group: 'نوبت',
    key: 'booking.patient_cancel_cutoff_minutes',
    label: 'مهلت لغو بیمار (دقیقه)',
    manage: BUSINESS,
  },
  {
    group: 'نوبت',
    key: 'booking.center_approval_sla_minutes',
    label: 'مهلت پاسخ مرکز (دقیقه)',
    manage: BUSINESS,
  },
  { group: 'نوبت', key: 'booking.sms_templates', label: 'متن پیامک‌های نوبت', manage: BUSINESS },
  {
    group: 'پیامک',
    key: 'notification.promotional_campaigns_enabled',
    label: 'پیامک تبلیغاتی گروهی',
    manage: TECH,
    flag: 'boolean',
  },
  {
    group: 'پیامک',
    key: 'notification.allowed_hours',
    label: 'ساعت‌های مجاز ارسال',
    manage: BUSINESS,
  },
  {
    group: 'پیامک',
    key: 'notification.bulk_two_person_threshold',
    label: 'آستانه تأیید دونفره ارسال گروهی',
    manage: BUSINESS,
  },
  {
    group: 'پیامک',
    key: 'notification.campaign_batch_per_minute',
    label: 'سرعت ارسال گروهی (در دقیقه)',
    manage: TECH,
  },
  {
    group: 'پیامک',
    key: 'notification.segment_cost_rial',
    label: 'هزینه هر پیامک (ریال)',
    manage: BUSINESS,
  },
  {
    group: 'پیامک',
    key: 'notification.sms_credit_alert_rial',
    label: 'آستانه هشدار اعتبار پیامک (ریال؛ ۰ = خاموش)',
    manage: BUSINESS,
  },
];
