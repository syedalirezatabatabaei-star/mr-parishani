import {
  addJalaliDays,
  addJalaliMonths,
  fromJalali,
  gregorianToJalali,
  hiddenFieldsFor,
  toJalali,
  type DayRange,
  type PermissionCode,
  type ReportColumn,
  type ReportColumnKind,
} from '@sepehr/contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';

/** A cell as a report's query returns it: rials and counts as digits, days and instants. */
export type RawCell = string | number | boolean | Date | bigint | null;
export type RawRow = Record<string, RawCell>;

export interface ReportColumnDefinition {
  readonly key: string;
  readonly title: string;
  readonly kind: ReportColumnKind;
  /** Shown only to a holder of this permission (in the page and in every export). */
  readonly permission?: PermissionCode;
  /**
   * An encrypted field's value (doc 17 §5): always masked to its last four characters; whole
   * only in an export by a holder of reporting.export_sensitive who gave a reason, from
   * `reveal` (the owning module's port; this module never decrypts).
   */
  readonly sensitive?: boolean;
  /** Labels of coded values (a status): what the page and the file show. */
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * A report (doc 17 §2 principle 2): its parameters, columns, permission and scope, defined in
 * code. Its query runs on the read-only reporting connection only (ADR-012; test 6) and gets
 * the caller's scope as a condition, the same rule as the API's (principle 3).
 */
export interface ReportDefinition<P extends z.ZodType = z.ZodType> {
  readonly code: string;
  readonly title: string;
  /** Any of these runs it, besides reporting.run. */
  readonly permissions: readonly PermissionCode[];
  readonly params: P;
  readonly columns: readonly ReportColumnDefinition[];
  /**
   * The materialized views it reads (task 7-4): its result says how fresh they are. A report
   * of plain tables (with their indexes) has none.
   */
  readonly views: readonly string[];
  /** The rows the caller may see, as a condition of the query (rule 13). */
  scope(access: EffectiveAccess): SQL;
  /**
   * Its query, run by the service on the reporting connection only (test 6) and explained by
   * the same path (task 7-4); `range` already made concrete.
   */
  statement(params: z.output<P>, scope: SQL, range: { from: Date; to: Date } | null): SQL;
  /** The whole values of the sensitive columns of these rows, by the same keys. */
  reveal?(rows: readonly RawRow[]): Promise<RawRow[]>;
}

/** The columns the caller may see: by permission, and by the API's field filter (doc 04 §4). */
export function visibleColumns(
  definition: ReportDefinition,
  access: EffectiveAccess,
): ReportColumnDefinition[] {
  const hidden = hiddenFieldsFor(access.permissions);
  return definition.columns.filter(
    (c) => !hidden.has(c.key) && (!c.permission || access.permissions.has(c.permission)),
  );
}

export const columnView = (c: ReportColumnDefinition): ReportColumn => ({
  key: c.key,
  title: c.title,
  kind: c.kind,
  sensitive: c.sensitive === true,
});

/** An encrypted field as everyone sees it: its last four characters. */
export function mask(value: string): string {
  const last = value.slice(-4);
  return `${'•'.repeat(Math.max(0, Math.min(8, value.length - last.length)))}${last}`;
}

const tehranDay = (at: Date) => toJalali(at);

/** A range of Tehran days as instants [from, to): relative to `now`, or fixed days. */
export function rangeOf(range: DayRange, now: Date): { from: Date; to: Date } {
  if ('relative' in range) {
    const today = tehranDay(now);
    const tomorrow = fromJalali(addJalaliDays(today, 1));
    switch (range.relative) {
      case 'today':
        return { from: fromJalali(today), to: tomorrow };
      case 'last_7_days':
        return { from: fromJalali(addJalaliDays(today, -6)), to: tomorrow };
      case 'last_30_days':
        return { from: fromJalali(addJalaliDays(today, -29)), to: tomorrow };
      case 'this_month': {
        const first = { ...today, day: 1 };
        return { from: fromJalali(first), to: fromJalali(addJalaliMonths(first, 1)) };
      }
      case 'last_month': {
        const first = { ...today, day: 1 };
        return { from: fromJalali(addJalaliMonths(first, -1)), to: fromJalali(first) };
      }
    }
  }
  const day = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return gregorianToJalali({ year: y ?? 0, month: m ?? 0, day: d ?? 0 });
  };
  return { from: fromJalali(day(range.from)), to: fromJalali(addJalaliDays(day(range.to), 1)) };
}

/** The Tehran day of an instant, as `YYYY-MM-DD` (the ledger view's `day`). */
export function tehranDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The days of a range, [from, to), for the ledger view; all time when none. */
export function dayBounds(range: { from: Date; to: Date } | null): { from: string; to: string } {
  return range
    ? { from: tehranDate(range.from), to: tehranDate(range.to) }
    : { from: '0001-01-01', to: '9999-12-31' };
}

/**
 * A company-wide report's scope (task 7-4): everything for a global scope; nothing otherwise,
 * since its rows carry no city or center to narrow by (rule 13: refused rather than guessed).
 */
export const globalOnly = (access: EffectiveAccess): SQL =>
  access.scopes.some((s) => s.kind === 'global') ? sql`true` : sql`false`;
