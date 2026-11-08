import { searchReportParamsSchema } from '@sepehr/contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { ReportDefinition } from '../report-definition';

/**
 * The search log's reports (task 7-6; doc 17 §6): which filters people use, alone and together,
 * and how slow each is (p95). The system admin's; nothing personal is in the log.
 */

const inRange = (range: { from: Date; to: Date } | null): SQL =>
  range
    ? sql`created_at >= ${range.from.toISOString()} AND created_at < ${range.to.toISOString()}`
    : sql`true`;

export const searchFiltersReport: ReportDefinition<typeof searchReportParamsSchema> = {
  code: 'search_filters',
  title: 'فیلترهای جست‌وجو',
  permissions: ['reporting.read_search'],
  params: searchReportParamsSchema,
  views: [],
  columns: [
    { key: 'filter', title: 'فیلتر', kind: 'text' },
    { key: 'searches', title: 'جست‌وجو', kind: 'int' },
    { key: 'share', title: 'سهم (درصد)', kind: 'text' },
    { key: 'avgMs', title: 'میانگین زمان (ms)', kind: 'int' },
    { key: 'p95Ms', title: 'صدک ۹۵ زمان (ms)', kind: 'int' },
  ],
  scope: () => sql`true`,
  statement(_p, scope, range) {
    return sql`
      WITH l AS (SELECT * FROM search_query_log WHERE ${scope} AND ${inRange(range)}),
      f AS (SELECT unnest(CASE WHEN cardinality(filters) = 0 THEN ARRAY['none'] ELSE filters END)
              AS filter, duration_ms FROM l)
      SELECT f.filter, count(*)::int AS searches,
        to_char(round(100.0 * count(*) / nullif((SELECT count(*) FROM l), 0), 2), 'FM9990.00')
          AS share,
        round(avg(f.duration_ms))::int AS "avgMs",
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY f.duration_ms))::int AS "p95Ms"
      FROM f GROUP BY f.filter ORDER BY searches DESC, f.filter
    `;
  },
};

export const searchCombinationsReport: ReportDefinition<typeof searchReportParamsSchema> = {
  code: 'search_combinations',
  title: 'ترکیب فیلترهای جست‌وجو',
  permissions: ['reporting.read_search'],
  params: searchReportParamsSchema,
  views: [],
  columns: [
    { key: 'combination', title: 'ترکیب', kind: 'text' },
    { key: 'searches', title: 'جست‌وجو', kind: 'int' },
    { key: 'withTerm', title: 'با عبارت', kind: 'int' },
    { key: 'avgMs', title: 'میانگین زمان (ms)', kind: 'int' },
    { key: 'p95Ms', title: 'صدک ۹۵ زمان (ms)', kind: 'int' },
  ],
  scope: () => sql`true`,
  statement(_p, scope, range) {
    return sql`
      SELECT filter_combo AS combination, count(*)::int AS searches,
        count(*) FILTER (WHERE has_term)::int AS "withTerm",
        round(avg(duration_ms))::int AS "avgMs",
        round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS "p95Ms"
      FROM search_query_log
      WHERE ${scope} AND ${inRange(range)}
      GROUP BY filter_combo ORDER BY searches DESC, combination
    `;
  },
};

export const SEARCH_REPORTS = [searchFiltersReport, searchCombinationsReport] as const;
