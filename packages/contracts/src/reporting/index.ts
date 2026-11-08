import * as z from 'zod';
import { normalizePersianText } from '../text/persian.js';

/**
 * Reports and exports (task 7-3; doc 17 §2, §4, §5): each report defined in code (its
 * parameters, columns, permission, scope and each column's sensitivity), run on the read-only
 * reporting connection only (ADR-012), the API's field filter applied; saved filters keep only
 * conditions, relative ranges relative; an export is exactly what the page shows, recorded.
 */

export const REPORT_COLUMN_KINDS = ['text', 'int', 'rial', 'date', 'datetime', 'bool'] as const;
export type ReportColumnKind = (typeof REPORT_COLUMN_KINDS)[number];

export const MONEY_UNITS = ['rial', 'toman'] as const;
export type MoneyUnit = (typeof MONEY_UNITS)[number];

export const EXPORT_FORMATS = ['csv', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATUSES = ['queued', 'ready', 'failed'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** Kept relative in a saved filter, made a Jalali range of Tehran days when run (§4). */
export const RELATIVE_RANGES = [
  'today',
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
] as const;
export type RelativeRange = (typeof RELATIVE_RANGES)[number];

/** A range of days: relative, or fixed Gregorian days (the UI takes them in Jalali). */
export const dayRangeSchema = z.union([
  z.strictObject({ relative: z.enum(RELATIVE_RANGES) }),
  z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
]);
export type DayRange = z.output<typeof dayRangeSchema>;

const reason = z.string().transform(normalizePersianText).pipe(z.string().min(3).max(500));
const params = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/), z.unknown());

// --- the reports' own parameters -----------------------------------------------------------

/** «شکایات و تیکت» (doc 17 §2): opened in a range, by unit and status. */
export const ticketsReportParamsSchema = z.strictObject({
  range: dayRangeSchema.optional(),
  unit: z
    .string()
    .regex(/^[a-z][a-z_]{1,39}$/)
    .optional(),
  status: z
    .enum([
      'open',
      'assigned',
      'in_progress',
      'waiting_on_requester',
      'resolved',
      'closed',
      'reopened',
    ])
    .optional(),
});

const code40 = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

/** «قیف فروش» and «علت‌های انصراف» (task 7-4): cases made in a range, by source, field, city, advisor. */
export const salesReportParamsSchema = z.strictObject({
  range: dayRangeSchema.optional(),
  channel: code40.optional(),
  treatmentField: code40.optional(),
  city: code40.optional(),
  assignee: z.uuid().optional(),
});

/** «اعتبار» (task 7-4): applications submitted in a range. */
export const creditReportParamsSchema = z.strictObject({ range: dayRangeSchema.optional() });

/** «تسویه مراکز» (task 7-4): a range of days (a month, for the monthly view), one doctor if named. */
export const settlementReportParamsSchema = z.strictObject({
  range: dayRangeSchema.optional(),
  doctorNodeId: z.uuid().optional(),
});

/** «مطالبات» (task 7-4; 7.1: both bases, 30 days): collection in a range. */
export const receivablesReportParamsSchema = z.strictObject({
  range: dayRangeSchema.optional(),
  thresholdDays: z.number().int().min(1).max(3650).default(30),
});

/** «سنی‌سازی معوقات» (task 7-4): the buckets' first days (6.4: 1, 31, 61, 91). */
export const agingReportParamsSchema = z.strictObject({
  buckets: z
    .array(z.number().int().min(1).max(3650))
    .min(1)
    .max(8)
    .refine((b) => b.every((d, i) => i === 0 || d > (b[i - 1] ?? 0)), 'ascending')
    .default([1, 31, 61, 91]),
});

/** «عملکرد کارشناسان» (task 7-4): assignments in a range, one queue if named. */
export const agentsReportParamsSchema = z.strictObject({
  range: dayRangeSchema.optional(),
  queue: code40.optional(),
});

/** «کیف اعتبار» (task 7-4): a range of days, one center if named. */
export const walletReportParamsSchema = z.strictObject({
  range: dayRangeSchema.optional(),
  centerNodeId: z.uuid().optional(),
});

// --- inputs ---------------------------------------------------------------------------------

export const runReportSchema = z.strictObject({ params: params.default({}) });

export const exportReportSchema = z.strictObject({
  params: params.default({}),
  format: z.enum(EXPORT_FORMATS),
  moneyUnit: z.enum(MONEY_UNITS).default('rial'),
  /** The full value of encrypted fields (doc 17 §5): reporting.export_sensitive and a reason. */
  sensitive: z.strictObject({ reason }).optional(),
});

export const savedFilterInputSchema = z.strictObject({
  reportCode: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  name: z.string().transform(normalizePersianText).pipe(z.string().min(2).max(80)),
  conditions: params,
  /** Shared with one unit (a role the sharer holds): reporting.share_filters. */
  sharedUnit: z
    .string()
    .regex(/^[a-z][a-z_]{1,39}$/)
    .optional(),
});

export const deleteSavedFilterSchema = z.strictObject({ reason: reason.optional() });

// --- views ----------------------------------------------------------------------------------

const instant = z.iso.datetime({ offset: true });

export const reportColumnSchema = z.object({
  key: z.string(),
  title: z.string(),
  kind: z.enum(REPORT_COLUMN_KINDS),
  sensitive: z.boolean(),
});
export type ReportColumn = z.output<typeof reportColumnSchema>;

export const reportListItemSchema = z.object({
  code: z.string(),
  title: z.string(),
  columns: z.array(reportColumnSchema),
  /** Task 7-7: the parameters it takes (`range`, `unit`, …), for the page's one filter. */
  params: z.array(z.string()),
});

/** A cell: rials and counts as strings of digits, days as Gregorian days, instants as ISO. */
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const reportResultSchema = z.object({
  code: z.string(),
  title: z.string(),
  columns: z.array(reportColumnSchema),
  rows: z.array(z.record(z.string(), cell)),
  /** Rows of the whole result; the page shows at most `limit` of them. */
  total: z.int(),
  limit: z.int(),
  /** The parameters as run, a relative range made concrete. */
  applied: z.record(z.string(), z.unknown()),
  /** How fresh: the oldest refresh of the materialized views it reads (task 7-4); null if none. */
  asOf: instant.nullable().optional(),
});
export type ReportResult = z.output<typeof reportResultSchema>;

export const reportExportSchema = z.object({
  id: z.uuid(),
  reportCode: z.string(),
  format: z.enum(EXPORT_FORMATS),
  moneyUnit: z.enum(MONEY_UNITS),
  sensitive: z.boolean(),
  status: z.enum(EXPORT_STATUSES),
  rowCount: z.int().nullable(),
  createdAt: instant,
  finishedAt: instant.nullable(),
});
export type ReportExport = z.output<typeof reportExportSchema>;

export const reportExportLinkSchema = z.object({ url: z.string(), expiresInSeconds: z.int() });

export const savedFilterSchema = z.object({
  id: z.uuid(),
  reportCode: z.string(),
  name: z.string(),
  conditions: z.record(z.string(), z.unknown()),
  sharedUnit: z.string().nullable(),
  mine: z.boolean(),
  createdAt: instant,
});
export type SavedFilter = z.output<typeof savedFilterSchema>;

// --- dashboards (task 7-5; doc 17 §3) ---------------------------------------------------------

/** The CEO's dashboard: the tiles, the six months' trend, and how fresh it is. */
export const ceoDashboardSchema = z.object({
  activeCases: z.int(),
  chargedThisMonthRial: z.string(),
  outstandingDebtRial: z.string(),
  /** Overdue 30+ days by amount (task 7-4's basis), a percent with two decimals, or null. */
  overdueRatio: z.string().nullable(),
  openComplaints: z.int(),
  trend: z.array(
    z.object({
      /** The Jalali month, `YYYY/MM` in Persian digits. */
      month: z.string(),
      chargedRial: z.string(),
      collectedRial: z.string(),
    }),
  ),
  asOf: instant.nullable(),
});
export type CeoDashboard = z.output<typeof ceoDashboardSchema>;

/** A unit's dashboard: its ticket queue, deadlines at risk, its agents' load, opened by day. */
export const unitDashboardSchema = z.object({
  unit: z.string(),
  open: z.int(),
  unassigned: z.int(),
  overdue: z.int(),
  atRisk: z.int(),
  /** The window «at risk» was counted in, in minutes. */
  atRiskMinutes: z.int(),
  agents: z.array(z.object({ accountId: z.uuid(), queue: z.string(), open: z.int() })),
  opened: z.array(z.object({ day: z.iso.date(), tickets: z.int() })),
  asOf: instant.nullable(),
});
export type UnitDashboard = z.output<typeof unitDashboardSchema>;

/** The doctor's rank in their field (doc 09 open item 7): patients completed in 90 days. */
export const doctorDashboardSchema = z.object({
  ranks: z.array(
    z.object({
      doctorNodeId: z.uuid(),
      treatmentField: z.string(),
      patients: z.int(),
      rank: z.int(),
      of: z.int(),
    }),
  ),
});
export type DoctorDashboard = z.output<typeof doctorDashboardSchema>;

// --- the search log (task 7-6; doc 17 §6) -----------------------------------------------------

/** «جست‌وجو»: searches in a range. */
export const searchReportParamsSchema = z.strictObject({ range: dayRangeSchema.optional() });

/** The index suggestions as a Markdown file, for a reviewed migration (never applied by itself). */
export const searchInsightsSchema = z.object({ markdown: z.string() });

/** Task 7-7: the ticket topics' names, for the report page to show a topic code as its name. */
export const reportTopicNamesSchema = z.array(z.object({ code: z.string(), title: z.string() }));
