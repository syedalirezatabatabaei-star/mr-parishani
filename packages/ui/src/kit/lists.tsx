import type { ReactNode } from 'react';
import { faDigits } from './format.js';
import { buttonClass } from './controls.js';

/**
 * Lists with one server-side filter (doc 09, 2-11: «همه فهرست‌ها با فیلتر یکپارچه سمت
 * سرور»). The URL's query is the one source of the filter: `FilterBar` is a GET form, so the
 * page on the server reads the same parameters and asks the API for that page of results.
 * It works with no JavaScript, and a filtered list can be shared or bookmarked.
 */

export interface FilterBarProps {
  /** The page's own path; the form GETs it. */
  readonly action: string;
  /** Accessible name of the filter region. */
  readonly label?: string;
  /** Where «پاک کردن» goes: the path without any filter. */
  readonly resetHref?: string;
  readonly submitLabel?: string;
  readonly children: ReactNode;
}

export function FilterBar({
  action,
  label = 'فیلتر',
  resetHref,
  submitLabel = 'اعمال فیلتر',
  children,
}: FilterBarProps) {
  return (
    <form
      role="search"
      aria-label={label}
      method="get"
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3"
    >
      {children}
      <div className="flex gap-2">
        <button type="submit" className={buttonClass('primary')}>
          {submitLabel}
        </button>
        {resetHref && (
          <a href={resetHref} className={buttonClass('quiet')}>
            پاک کردن
          </a>
        )}
      </div>
    </form>
  );
}

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  /** Numbers and money: aligned to the end, digits of one width. */
  readonly numeric?: boolean;
}

export interface DataTableProps<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  /** Shown instead of an empty table. */
  readonly empty: ReactNode;
}

/** A table that scrolls on its own on a phone, never the page. */
export function DataTable<T>({ caption, columns, rows, rowKey, empty }: DataTableProps<T>) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full border-collapse text-[length:var(--text-sm)]">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-sunken text-ink-muted">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={`px-3 py-2 font-medium whitespace-nowrap ${c.numeric ? 'text-end' : 'text-start'}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-t border-border">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`px-3 py-2 align-middle ${c.numeric ? 'figures text-end' : 'text-start'}`}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface PaginationProps {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  /** The address of a page with the current filter kept. */
  readonly hrefFor: (page: number) => string;
}

/** Pages as links (the filter stays in the URL); the count is said in words too. */
export function Pagination({ page, pageSize, total, hrefFor }: PaginationProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const link = (to: number, label: string, rel?: string) =>
    to < 1 || to > pages ? (
      <span aria-disabled="true" className={buttonClass('secondary')}>
        {label}
      </span>
    ) : (
      <a href={hrefFor(to)} rel={rel} className={buttonClass('secondary')}>
        {label}
      </a>
    );
  return (
    <nav aria-label="صفحه‌ها" className="flex items-center justify-between gap-3">
      {link(page - 1, 'صفحه قبل', 'prev')}
      <span className="figures text-[length:var(--text-sm)] text-ink-muted" aria-current="page">
        صفحه {faDigits(page)} از {faDigits(pages)} ({faDigits(total)} مورد)
      </span>
      {link(page + 1, 'صفحه بعد', 'next')}
    </nav>
  );
}

/**
 * The address of `path` with `params` changed: `null` removes a key, other keys stay. For
 * the pages of a filtered list and for links that keep the filter.
 */
export function withParams(
  path: string,
  current: Readonly<Record<string, string | readonly string[] | undefined>>,
  changes: Readonly<Record<string, string | number | null>>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (key in changes || value === undefined) continue;
    const values: readonly string[] = typeof value === 'string' ? [value] : value;
    for (const v of values) if (v !== '') params.append(key, v);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value !== null && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query === '' ? path : `${path}?${query}`;
}
