import type { PermissionCode } from '@sepehr/contracts';
import {
  formatRial,
  formatToman,
  normalizeDigits,
  parseRial,
  toPersianDigits,
} from '@sepehr/contracts';

/**
 * The launch-day settings (owner 1405/08/01–02, plan pilot-panel-gaps-plan.md item الف): six
 * keys typed in plain fields instead of JSON. Each goes through the same versioned proposal a
 * second person approves; the server checks the category, the two people and each key's schema
 * (rule 12), whatever this page sends.
 */
/** `days`: a whole number of days; `monthday`: a Jalali day of the month (owner 1405/08/10). */
export type LaunchKind = 'cap' | 'rial' | 'count' | 'percent' | 'flag' | 'days' | 'monthday';

/** The range a typed number must be in, as the key's own schema has it. */
export interface Bounds {
  readonly min: number;
  readonly max: number;
}

export interface LaunchKey {
  readonly key: string;
  readonly label: string;
  readonly kind: LaunchKind;
  readonly manage: PermissionCode;
  /** What the annex or the owner set, shown beside the field (rials, a count, bps or on/off). */
  readonly agreed: string;
  /** The launch check's item for this key, if it has one. */
  readonly launchCheckItem?: number;
  /** A number's range, when the schema's is narrower than the kind's. */
  readonly bounds?: Bounds;
}

const BUSINESS: PermissionCode = 'config.manage_business';
const TECH: PermissionCode = 'config.manage_technical';

export const LAUNCH_KEYS: readonly [LaunchKey, ...LaunchKey[]] = [
  {
    key: 'credit.borrower_exposure_cap',
    label: 'سقف مانده فعال هر وام‌گیرنده (ریال)',
    kind: 'cap',
    manage: BUSINESS,
    agreed: '۱٬۵۰۰٬۰۰۰٬۰۰۰ ریال روی آنچه هنوز بدهکار است (ADR-051)',
    launchCheckItem: 20,
  },
  {
    key: 'instrument.borrower_cheque_min_count',
    label: 'قاعده چک: کمینه چک وام‌گیرنده',
    kind: 'count',
    manage: BUSINESS,
    agreed: '۱ (ج۵)',
    launchCheckItem: 17,
  },
  {
    key: 'instrument.guarantee_cheque_min_bps',
    label: 'قاعده چک: ضمانت هر ضامن (درصد مبلغ پیش‌فاکتور)',
    kind: 'percent',
    manage: BUSINESS,
    agreed: '۱۱۰٪ (۱۱۰۰۰ واحد پایه؛ ج۵)',
    launchCheckItem: 17,
  },
  {
    key: 'credit.formation_deposit_rial',
    label: 'بیعانه تشکیل (ریال)',
    kind: 'rial',
    manage: BUSINESS,
    agreed: '۹۹۰٬۰۰۰ ریال (مالک ۱۴۰۵/۰۷/۲۹)',
  },
  {
    key: 'catalog.visit_tariff_internal_only',
    label: 'تعرفه ویزیت فقط از پنل داخلی',
    kind: 'flag',
    manage: BUSINESS,
    agreed: 'به تصمیم مالک',
  },
  {
    key: 'catalog.search_enabled',
    label: 'جست‌وجوی عمومی پزشک',
    kind: 'flag',
    manage: TECH,
    agreed: 'خاموش در پایلوت (مالک ۱۴۰۵/۰۸/۰۱)',
  },
];

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

const asObject = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/**
 * What a person typed, as the key's stored value. Any digits (Persian, Arabic, Latin), with or
 * without separators; rials whole only (rule 1). The cap keeps its basis and what it counts.
 */
export function toConfigValue(
  kind: LaunchKind,
  typed: string,
  current: unknown,
  bounds?: Bounds,
): Parsed {
  if (kind === 'flag') {
    if (typed === 'on') return { ok: true, value: true };
    if (typed === 'off') return { ok: true, value: false };
    return { ok: false, error: 'روشن یا خاموش را انتخاب کنید.' };
  }
  if (kind === 'rial' || kind === 'cap') {
    const rial = parseRial(typed);
    if (rial === null) return { ok: false, error: 'مبلغ را به ریال و بی اعشار بنویسید.' };
    if (kind === 'rial') return { ok: true, value: rial.toString() };
    const base = asObject(current);
    return {
      ok: true,
      value: {
        capRial: rial.toString(),
        basis: base['basis'] === 'loan' ? 'loan' : 'obligation',
        includeApprovedUnfunded:
          typeof base['includeApprovedUnfunded'] === 'boolean'
            ? base['includeApprovedUnfunded']
            : true,
      },
    };
  }
  const text = normalizeDigits(typed).trim().replace(/[٫]/g, '.');
  if (kind === 'days' || kind === 'monthday') {
    const { min, max } = bounds ?? (kind === 'days' ? { min: 0, max: 3650 } : { min: 1, max: 29 });
    if (!/^\d{1,4}$/.test(text) || Number(text) < min || Number(text) > max) {
      return {
        ok: false,
        error: `یک عدد صحیح از ${toPersianDigits(min)} تا ${toPersianDigits(max)} بنویسید.`,
      };
    }
    return { ok: true, value: Number(text) };
  }
  if (kind === 'count') {
    if (!/^\d{1,3}$/.test(text) || Number(text) > 100) {
      return { ok: false, error: 'یک عدد صحیح از ۰ تا ۱۰۰ بنویسید.' };
    }
    return { ok: true, value: Number(text) };
  }
  // A percent with at most two decimals, stored as basis points (1% = 100).
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: 'درصد را با حداکثر دو رقم اعشار بنویسید (مثلاً ۱۱۰).' };
  }
  const [whole = '0', fraction = ''] = text.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (bps > 100_000) return { ok: false, error: 'درصد از ۱۰۰۰ بیشتر نمی‌شود.' };
  if (bounds && (bps < bounds.min || bps > bounds.max)) {
    return {
      ok: false,
      error: `درصد باید از ${toPersianDigits(String(bounds.min / 100))} تا ${toPersianDigits(String(bounds.max / 100))} باشد.`,
    };
  }
  return { ok: true, value: bps };
}

/** A stored value in plain Persian. */
export function shownValue(kind: LaunchKind, value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (kind === 'flag') return value === true ? 'روشن' : 'خاموش';
  if (kind === 'rial') {
    const rial = typeof value === 'string' ? value : '0';
    return rial === '0' ? 'خاموش (۰)' : `${formatRial(rial)} (${formatToman(rial)})`;
  }
  if (kind === 'cap') {
    const cap = asObject(value);
    const rial = typeof cap['capRial'] === 'string' ? cap['capRial'] : '0';
    if (rial === '0') return 'خاموش (۰)';
    const basis = cap['basis'] === 'loan' ? 'مبلغ وام' : 'آنچه هنوز بدهکار است';
    return `${shownValue('rial', rial)}، روی ${basis}${cap['includeApprovedUnfunded'] === false ? '' : '، با تأییدشده‌های شارژنشده'}`;
  }
  if (kind === 'count') return typeof value === 'number' ? toPersianDigits(value) : '—';
  if (kind === 'days') return typeof value === 'number' ? `${toPersianDigits(value)} روز` : '—';
  if (kind === 'monthday') {
    return typeof value === 'number' ? `روز ${toPersianDigits(value)} هر ماه شمسی` : '—';
  }
  const bps = typeof value === 'number' ? value : 0;
  return bps === 0
    ? 'خاموش (۰)'
    : `${toPersianDigits(String(bps / 100))}٪ (${toPersianDigits(String(bps))} واحد پایه)`;
}

/**
 * Business keys that had no page (owner 1405/08/10): the cancellation penalty, a cheque's
 * execution, promissory notes, the doctors' payout day and an installment's grace. The same
 * versioned proposal and second person as every key here; the server checks each schema.
 */
export const OTHER_BUSINESS_KEYS: readonly [LaunchKey, ...LaunchKey[]] = [
  {
    key: 'repayment.cancellation_penalty_bps',
    label: 'خسارت انصراف پس از شارژ (درصد مبلغ مصوب وام)',
    kind: 'percent',
    manage: BUSINESS,
    agreed: '۱۸٪ (مالک پ۱۳)؛ بیش از ۱۸٪ فقط با ADR تازه',
    bounds: { min: 0, max: 1_800 },
  },
  {
    key: 'repayment.cancellation_penalty_due_days',
    label: 'مهلت پرداخت خسارت انصراف (روز)',
    kind: 'days',
    manage: BUSINESS,
    agreed: '۳۰ روز (مالک پ۱۲-ب)',
    bounds: { min: 1, max: 365 },
  },
  {
    key: 'instrument.execution_min_days_past_due',
    label: 'کمینه روز معوق برای پیشنهاد اجرای چک',
    kind: 'days',
    manage: BUSINESS,
    agreed: '۰ (هر وام معوق)',
    bounds: { min: 0, max: 3_650 },
  },
  {
    key: 'instrument.promissory_enabled',
    label: 'پذیرش سفته',
    kind: 'flag',
    manage: BUSINESS,
    agreed: 'خاموش (مالک ۱۴۰۵/۰۷/۲۷)',
  },
  {
    key: 'settlement.payout_day',
    label: 'روز پرداخت تسویه پزشکان',
    kind: 'monthday',
    manage: BUSINESS,
    agreed: 'روز ۱۰ هر ماه (مالک)',
    bounds: { min: 1, max: 29 },
  },
  {
    key: 'repayment.grace_days',
    label: 'مهلت قسط پس از سررسید (روز)',
    kind: 'days',
    manage: BUSINESS,
    agreed: '۰ (۶.۲)',
    bounds: { min: 0, max: 90 },
  },
];
