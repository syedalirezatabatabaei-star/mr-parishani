import type { AnnouncementAudience, BannerAudience, ContentStatus } from '@sepehr/contracts';
import type { StatusTone } from '@sepehr/ui';

/** The portal's content as «مدیریت محتوای پیشخوان» names it (owner 1405/08/10). */
export const BANNER_AUDIENCE: Readonly<Record<BannerAudience, string>> = {
  patient: 'بیماران',
  center: 'مراکز',
  doctor: 'پزشکان',
  staff: 'کارکنان (پنل داخلی)',
};

export const BANNER_TONE: Readonly<Record<string, string>> = {
  accent: 'رنگ اصلی',
  highlight: 'رنگ تأکید',
  indigo: 'نیلی',
  teal: 'فیروزه‌ای',
  rose: 'سرخابی',
  amber: 'کهربایی',
};

export const ANNOUNCEMENT_AUDIENCE: Readonly<Record<AnnouncementAudience, string>> = {
  all: 'همه',
  patients: 'بیماران',
  centers: 'مراکز و پزشکان',
  staff: 'همه کارکنان',
  role: 'یک نقش مشخص',
};

export const CONTENT_STATUS: Readonly<Record<ContentStatus, { label: string; tone: StatusTone }>> =
  {
    pending: { label: 'منتظر تأیید نفر دوم', tone: 'warning' },
    approved: { label: 'تأییدشده', tone: 'success' },
    rejected: { label: 'ردشده', tone: 'danger' },
  };
