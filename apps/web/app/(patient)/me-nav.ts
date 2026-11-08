import {
  shortcutsIn,
  toDeskItems,
  type DeskItem,
  type SectionOf,
  type TileColor,
} from '@sepehr/ui';

/** The patient's groups, in their order, each with its color (owner 1405/08/10). */
export const PATIENT_GROUPS = {
  visit: { label: 'نوبت و پزشک', color: 'teal' },
  credit: { label: 'اعتبار و پرداخت', color: 'indigo' },
  account: { label: 'حساب و پشتیبانی', color: 'rose' },
} as const satisfies Record<string, { label: string; color: TileColor }>;

/**
 * Every signed-in patient's services: the same pages the header linked before, and their
 * guarantees (a page that was there, never in the header). The API decides what each shows.
 */
export const PATIENT_SECTIONS: readonly SectionOf<keyof typeof PATIENT_GROUPS>[] = [
  {
    href: '/search',
    label: 'پیدا کردن پزشک',
    shortLabel: 'پزشک',
    description: 'جست‌وجوی پزشک و مرکز، زمان آزاد و نوبت.',
    group: 'visit',
    glyph: 'stethoscope',
  },
  {
    href: '/me/appointments',
    label: 'نوبت‌های من',
    shortLabel: 'نوبت‌ها',
    description: 'نوبت‌های پیش رو و گذشته؛ لغو و جابه‌جایی.',
    group: 'visit',
    glyph: 'calendar',
  },
  {
    href: '/me/proformas',
    label: 'پیش‌فاکتورها',
    shortLabel: 'پیش‌فاکتورها',
    description: 'پیش‌فاکتور پزشک را ببینید و تأیید کنید.',
    group: 'credit',
    glyph: 'proforma',
  },
  {
    href: '/me/credit',
    label: 'اعتبار من',
    shortLabel: 'اعتبار',
    description: 'پرونده اعتباری، مدارک، ضامن و تصمیم.',
    group: 'credit',
    glyph: 'shield',
  },
  {
    href: '/me/repayment',
    label: 'اقساط من',
    shortLabel: 'اقساط',
    description: 'اقساط، سررسیدها و ثبت فیش پرداخت.',
    group: 'credit',
    glyph: 'coins',
  },
  {
    href: '/me/contracts',
    label: 'قراردادها',
    shortLabel: 'قراردادها',
    description: 'قراردادهای اعتبار و پذیرش آن‌ها.',
    group: 'credit',
    glyph: 'contract',
  },
  {
    href: '/me/guarantees',
    label: 'ضمانت‌های من',
    shortLabel: 'ضمانت‌ها',
    description: 'پرونده‌هایی که ضامن آن‌ها هستید.',
    group: 'credit',
    glyph: 'guarantee',
    isNew: true,
  },
  {
    href: '/me/tickets',
    label: 'پشتیبانی',
    shortLabel: 'پشتیبانی',
    description: 'پرسش، درخواست و شکایت؛ پاسخ پشتیبانی.',
    group: 'account',
    glyph: 'chat',
  },
  {
    href: '/me/mobile',
    label: 'شماره موبایل',
    shortLabel: 'موبایل',
    description: 'تغییر شماره ورود با کد پیامکی.',
    group: 'account',
    glyph: 'mobile',
  },
];

export const patientItems = (counts: Readonly<Record<string, number>> = {}): DeskItem[] =>
  toDeskItems(PATIENT_SECTIONS, PATIENT_GROUPS, counts);

/** The phone's bar of shortcuts: the four most used. */
export const patientShortcuts = (items: readonly DeskItem[]) =>
  shortcutsIn(items, ['/me/appointments', '/search', '/me/repayment', '/me/tickets']);
