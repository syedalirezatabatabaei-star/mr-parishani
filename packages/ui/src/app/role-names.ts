/**
 * The roles' names as the menu shows who is signed in (owner 1405/08/10), the same as the
 * names in the access migrations (0002 and after). A code not here is shown as it is.
 */
export const ROLE_NAME: Readonly<Record<string, string>> = {
  accounting: 'حسابداری و تسویه',
  advisor: 'مشاور (حامی)',
  auditor: 'حسابرس',
  case_completion: 'کارشناس تکمیل پرونده',
  center_manager: 'مدیر مرکز',
  ceo: 'مدیرعامل',
  club_officer: 'مسئول باشگاه مشتریان',
  collection: 'واحد معوقات',
  collection_manager: 'مدیر واحد معوقات',
  credit_committee: 'عضو کمیته ریسک و اعتبار',
  credit_manager: 'مسئول / مدیر اعتبار',
  credit_specialist: 'کارشناس اعتبار',
  doctor: 'پزشک',
  holiday_deputy: 'قائم‌مقام مدیرعامل (فقط تعطیلات)',
  mobile_approver: 'تأیید شماره بیمار',
  mobile_change_approver: 'تأییدکننده سوم تغییر شماره امضاکنندگان',
  network_manager: 'مدیر شبکه درمان',
  network_specialist: 'کارشناس شبکه درمان',
  patient_mobile_changer: 'تغییر شماره بیمار',
  release_requester: 'درخواست‌دهنده استرداد چک و سفته',
  secretary: 'منشی',
  strategy_manager: 'مدیر استراتژی',
  support: 'پشتیبانی',
  system_admin: 'مدیر سیستم',
  technical_config_approver: 'تأییدکننده تنظیمات فنی',
};

/** Who is signed in, by their roles: «مدیر استراتژی»، or two roles joined. */
export function roleTitle(codes: readonly string[], fallback: string): string {
  const names = codes.map((c) => ROLE_NAME[c] ?? c);
  return names.length === 0 ? fallback : names.join('، ');
}
