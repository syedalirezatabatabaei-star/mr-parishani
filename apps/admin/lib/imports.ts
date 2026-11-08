import type { StatusTone } from '@sepehr/ui';

/** A batch's status in words (ADR-030). */
export const BATCH_STATUS = {
  previewed: { label: 'پیش‌نمایش', tone: 'info' },
  committed: { label: 'ثبت‌شده، در حال پردازش', tone: 'warning' },
  processed: { label: 'پردازش‌شده', tone: 'success' },
  cancelled: { label: 'لغوشده', tone: 'neutral' },
} as const satisfies Record<string, { label: string; tone: StatusTone }>;

/** A sheet's name as on the template (doc 08 §12). */
export const SHEET_NAMES: Readonly<Record<string, string>> = {
  centers: 'مراکز',
  branches: 'شعبه‌ها',
  doctors: 'پزشکان',
  tariffs: 'خدمات و تعرفه‌ها',
  schedules: 'الگوی تقویم',
};

/** A row status in words. */
export const ROW_STATUS: Readonly<Record<string, string>> = {
  valid: 'جدید',
  duplicate: 'تکراری',
  error: 'خطادار',
  created: 'ساخته‌شده',
  held: 'منتظر فعال‌سازی مرکز',
  proposed: 'پیشنهادی',
  applied: 'اعمال‌شده',
  failed: 'ناموفق',
  cancelled: 'لغوشده',
};

/** All rows of a batch, and those that will not be imported (duplicates, errors, failures). */
export function totals(summary: Readonly<Record<string, Readonly<Record<string, number>>>>) {
  let all = 0;
  let rejected = 0;
  for (const sheet of Object.values(summary)) {
    for (const [status, n] of Object.entries(sheet)) {
      all += n;
      if (status === 'duplicate' || status === 'error' || status === 'failed') rejected += n;
    }
  }
  return { all, rejected };
}
