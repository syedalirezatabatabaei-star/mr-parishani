'use client';

import { unwrap } from '@sepehr/api-client';
import type { ReportResult } from '@sepehr/contracts';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  showDay,
  showInstant,
  ticketUnit,
  toman,
  useApi,
} from '@sepehr/ui';
import { useEffect, useState } from 'react';

type Column = ReportResult['columns'][number];
type Cell = ReportResult['rows'][number][string];
type Names = Readonly<Record<string, string>>;

/** A queue's name: a unit's ticket queue by the unit's name (7-7), others as they are. */
const queueName = (code: string) =>
  code.startsWith('ticket_')
    ? `تیکت ${ticketUnit(code.slice('ticket_'.length))}`
    : ticketUnit(code);

/**
 * A cell as the page shows it (doc 17 §2 principle 5): Jalali days, tomans, Persian digits;
 * a unit, topic or queue code by its Persian name (the owner's ruling, 7-7: the display layer,
 * so exports keep the codes the definitions give).
 */
function shown(column: Column, value: Cell | undefined, topics: Names): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' && column.kind === 'text') {
    if (column.key === 'unit') return ticketUnit(value);
    if (column.key === 'topic') return topics[value] ?? value;
    if (column.key === 'queue') return queueName(value);
  }
  if (column.sensitive && typeof value === 'string' && value.includes('*')) return value;
  switch (column.kind) {
    case 'rial':
      return toman(String(value));
    case 'int':
      return faDigits(String(value));
    case 'date':
      return showDay(String(value));
    case 'datetime':
      return showInstant(String(value));
    case 'bool':
      return value === true ? 'بله' : 'خیر';
    default:
      return String(value);
  }
}

/**
 * The report run from the browser (task 7-7): `run` is a POST, which the API takes only with
 * the session's CSRF token and the page's origin, so the server page leaves it to this part.
 * It is still the API that applies the scope and the field masks (doc 17 §2 principle 3).
 * The page keys it by its parameters, so a new filter starts it afresh.
 */
export function ReportRun({
  code,
  title,
  params,
  rangeText,
  topics,
}: {
  /** The ticket topics' names by code. */
  topics: Names;
  code: string;
  title: string;
  params: Record<string, unknown>;
  rangeText: string;
}) {
  const api = useApi();
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(params);
  useEffect(() => {
    let live = true;
    unwrap(
      api.POST('/api/v1/reporting/reports/{code}/run', {
        params: { path: { code } },
        body: { params: JSON.parse(key) as Record<string, unknown> },
      }),
    )
      .then((r) => {
        if (live) setResult(r);
      })
      .catch((err: unknown) => {
        if (live) setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [api, code, key]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!result) {
    return (
      <p role="status" className="text-ink-muted">
        در حال اجرای گزارش…
      </p>
    );
  }
  return (
    <>
      <section aria-labelledby="applied" className="text-[length:var(--text-sm)] text-ink-muted">
        <h2 id="applied" className="sr-only">
          فیلتر اعمال‌شده
        </h2>
        <p>
          {rangeText}
          {result.total > result.rows.length
            ? `؛ نمایش ${faDigits(result.rows.length)} ردیف از ${faDigits(result.total)}. همه ردیف‌ها در خروجی می‌آیند.`
            : `؛ ${faDigits(result.total)} ردیف.`}
          {result.asOf ? ` داده به‌روز تا ${showInstant(result.asOf)}.` : ''}
        </p>
      </section>
      <DataTable
        caption={title}
        rows={result.rows.map((row, index) => ({ row, index }))}
        rowKey={(r) => String(r.index)}
        empty={<EmptyState title="در این بازه داده‌ای نیست." />}
        columns={result.columns.map((c) => ({
          key: c.key,
          header: c.title,
          cell: (r: { row: ReportResult['rows'][number] }) => shown(c, r.row[c.key], topics),
          numeric: c.kind === 'rial' || c.kind === 'int',
        }))}
      />
    </>
  );
}
