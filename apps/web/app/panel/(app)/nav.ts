import {
  shortcutsIn,
  toDeskItems,
  type DeskItem,
  type GlyphName,
  type TileColor,
} from '@sepehr/ui';

/**
 * The center panel's sections and the permission that opens each (doc 04). A section the
 * account cannot use is not shown; the API refuses it anyway (rule 12). Each has its group,
 * glyph and color on the service desk and in the menu (owner 1405/08/10).
 */
export interface PanelSection {
  readonly href: string;
  readonly label: string;
  /** The bottom bar's label (owner 1405/08/11): at most 12 letters, never cut. */
  readonly shortLabel: string;
  readonly group: PanelGroup;
  readonly glyph: GlyphName;
  readonly description: string;
  /** Any one of these opens the section; none: every signed-in account. */
  readonly anyOf: readonly string[];
}

/** The menu's groups, in their order, each with its color. */
export const PANEL_GROUPS = {
  daily: { label: 'کار روزانه', color: 'teal' },
  money: { label: 'پیش‌فاکتور و مالی', color: 'blue' },
  comms: { label: 'ارتباط', color: 'rose' },
  center: { label: 'مرکز و پزشکان', color: 'indigo' },
  account: { label: 'حساب', color: 'slate' },
} as const satisfies Record<string, { label: string; color: TileColor }>;
export type PanelGroup = keyof typeof PANEL_GROUPS;

export const PANEL_SECTIONS: readonly PanelSection[] = [
  {
    href: '/panel/dashboard',
    label: 'داشبورد',
    shortLabel: 'داشبورد',
    group: 'daily',
    glyph: 'chart',
    description: 'نوبت‌های امروز و هفته، رتبه شما، دریافتی‌های آینده و صورت‌وضعیت مرکز.',
    anyOf: [
      'booking.read_appointments',
      'booking.manage_appointments',
      'settlement.read_own',
      'settlement.read_center_summary',
    ],
  },
  {
    href: '/panel/appointments',
    label: 'نوبت‌ها',
    shortLabel: 'نوبت‌ها',
    group: 'daily',
    glyph: 'calendar',
    description: 'نوبت‌های در انتظار تأیید، امروز و آینده؛ تأیید، پذیرش و عدم حضور.',
    anyOf: ['booking.read_appointments', 'booking.manage_appointments'],
  },
  {
    href: '/panel/proformas',
    label: 'پیش‌فاکتورها',
    shortLabel: 'پیش‌فاکتورها',
    group: 'money',
    glyph: 'proforma',
    description: 'صدور پیش‌فاکتور برای بیمار معرفی‌شده، اصلاح با نسخه تازه و پاسخ بیمار.',
    anyOf: ['proforma.issue', 'proforma.read'],
  },
  {
    href: '/panel/patients',
    label: 'بیماران اعتباری',
    shortLabel: 'بیماران',
    group: 'daily',
    glyph: 'heart',
    description: 'بیماران شارژشده معرفی‌شده به شما؛ صدور مجوز خدمت و ورود کد بیمار.',
    anyOf: ['service.authorize'],
  },
  {
    href: '/panel/authorizations',
    label: 'تاریخچه خدمات',
    shortLabel: 'تاریخچه',
    group: 'money',
    glyph: 'history',
    description: 'مجوزهای خدمت صادرشده و وضعیت هر یک.',
    anyOf: ['service.read', 'service.authorize'],
  },
  {
    href: '/panel/settlement',
    label: 'تسویه',
    shortLabel: 'تسویه',
    group: 'money',
    glyph: 'bank',
    description: 'صورت‌وضعیت ماهانه، دریافتی‌های آینده، اقلام معلق و ثبت اعتراض.',
    anyOf: ['settlement.read_own', 'settlement.read_center_summary'],
  },
  {
    href: '/panel/tickets',
    label: 'تیکت‌ها',
    shortLabel: 'تیکت‌ها',
    group: 'comms',
    glyph: 'chat',
    description: 'پرسش و درخواست از واحدهای سپهر، و شکایت مالی روی قلم‌های تسویه.',
    anyOf: ['ticket.open_center'],
  },
  {
    href: '/panel/complaints',
    label: 'شکایت‌های بیماران',
    shortLabel: 'شکایت‌ها',
    group: 'comms',
    glyph: 'alert',
    description: 'شکایت بیماران درباره نوبت یا پیش‌فاکتور شما، و پاسخ به آن.',
    anyOf: ['ticket.respond'],
  },
  {
    href: '/panel/calendar',
    label: 'تقویم کاری',
    shortLabel: 'تقویم',
    group: 'daily',
    glyph: 'clock',
    description: 'ساعت‌های کاری پزشکان، استثناها و ظرفیت؛ نمای ماه، هفته و روز.',
    anyOf: [
      'booking.read_calendar',
      'booking.manage_own_calendar',
      'booking.manage_calendar_in_scope',
    ],
  },
  {
    href: '/panel/staff',
    label: 'پزشکان و منشی‌ها',
    shortLabel: 'پزشکان',
    group: 'center',
    glyph: 'users',
    description: 'پزشکان مرکز، منشی‌ها و دسترسی‌هایی که به آن‌ها واگذار شده.',
    anyOf: ['catalog.read_doctors', 'access.manage_secretaries'],
  },
  {
    href: '/panel/services',
    label: 'خدمات و تعرفه',
    shortLabel: 'تعرفه‌ها',
    group: 'center',
    glyph: 'priceTag',
    description: 'خدمات هر پزشک و تعرفه‌ها، از جمله تعرفه‌های پیشنهادی ورود از اکسل.',
    anyOf: ['catalog.read_tariffs', 'catalog.manage_tariffs'],
  },
  {
    href: '/panel/center',
    label: 'مرکز و شعبه‌ها',
    shortLabel: 'مرکز',
    group: 'center',
    glyph: 'building',
    description: 'اطلاعات مرکز، شعبه‌ها و درخواست‌های تغییر.',
    anyOf: ['catalog.read_centers', 'catalog.manage_centers'],
  },
  {
    href: '/panel/account',
    label: 'حساب من',
    shortLabel: 'حساب من',
    group: 'account',
    glyph: 'user',
    description: 'موبایل حساب، تأییدشده با کد؛ پیامک‌های سامانه به آن می‌رسد.',
    anyOf: [],
  },
];

export const sectionsFor = (permissions: readonly string[]) =>
  PANEL_SECTIONS.filter(
    (s) => s.anyOf.length === 0 || s.anyOf.some((p) => permissions.includes(p)),
  );

/** The sections as the desk and the menu show them, with their counts. */
export const deskItems = (
  sections: readonly PanelSection[],
  counts: Readonly<Record<string, number>> = {},
): DeskItem[] => toDeskItems(sections, PANEL_GROUPS, counts);

/** The services most used, first come first: the phone's bar of shortcuts takes four. */
const SHORTCUT_ORDER = [
  '/panel/appointments',
  '/panel/patients',
  '/panel/proformas',
  '/panel/calendar',
  '/panel/settlement',
  '/panel/tickets',
  '/panel/dashboard',
];

export const shortcutsOf = (items: readonly DeskItem[]) => shortcutsIn(items, SHORTCUT_ORDER);
