import {
  RELATIVE_RANGES,
  TICKET_STATUSES,
  type DayRange,
  type JalaliDate,
  type RelativeRange,
} from '@sepehr/contracts';
import {
  apiDay,
  jalaliOfDay,
  jalaliParam,
  one,
  parseJalaliParam,
  type SearchParams,
} from '@sepehr/ui';

/**
 * The report page's one filter (task 7-7; doc 17 §2 principle 5, §4) in its URL: a relative
 * range (`range=last_30_days`) or fixed Jalali days (`from`, `to`), and the report's own
 * parameters it names. The same URL runs, prints, saves and exports the same report.
 */

export const RANGE_LABEL: Readonly<Record<RelativeRange, string>> = {
  today: 'امروز',
  last_7_days: '۷ روز گذشته',
  last_30_days: '۳۰ روز گذشته',
  this_month: 'ماه جاری',
  last_month: 'ماه گذشته',
};

export interface PageFilter {
  readonly relative: RelativeRange | null;
  readonly from: JalaliDate | null;
  readonly to: JalaliDate | null;
  readonly unit: string | null;
  readonly status: (typeof TICKET_STATUSES)[number] | null;
}

export function filterOf(params: SearchParams): PageFilter {
  const relative = RELATIVE_RANGES.find((r) => r === one(params, 'range')) ?? null;
  const wanted = one(params, 'unit');
  const unit = wanted !== undefined && /^[a-z][a-z_]{1,39}$/.test(wanted) ? wanted : null;
  return {
    relative,
    from: relative ? null : parseJalaliParam(params['from']),
    to: relative ? null : parseJalaliParam(params['to']),
    unit,
    status: TICKET_STATUSES.find((s) => s === one(params, 'status')) ?? null,
  };
}

/** The report's parameters from the page's filter, only those the report takes. */
export function paramsOf(filter: PageFilter, takes: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (takes.includes('range')) {
    const range: DayRange | null = filter.relative
      ? { relative: filter.relative }
      : filter.from && filter.to
        ? { from: apiDay(filter.from), to: apiDay(filter.to) }
        : null;
    if (range) out['range'] = range;
  }
  if (takes.includes('unit') && filter.unit) out['unit'] = filter.unit;
  if (takes.includes('status') && filter.status) out['status'] = filter.status;
  return out;
}

/** A saved filter's conditions as the page's URL (relative ranges stay relative, §4). */
export function hrefOf(code: string, conditions: Record<string, unknown>): string {
  const q = new URLSearchParams();
  const raw = conditions['range'];
  if (typeof raw === 'object' && raw !== null) {
    const range = raw as Partial<{ relative: string; from: string; to: string }>;
    if (range.relative) q.set('range', range.relative);
    const from = range.from ? jalaliOfDay(range.from) : null;
    const to = range.to ? jalaliOfDay(range.to) : null;
    if (from && to) {
      q.set('from', jalaliParam(from));
      q.set('to', jalaliParam(to));
    }
  }
  for (const key of ['unit', 'status'] as const) {
    const value = conditions[key];
    if (typeof value === 'string') q.set(key, value);
  }
  const query = q.toString();
  return `/reports/${code}${query ? `?${query}` : ''}`;
}
