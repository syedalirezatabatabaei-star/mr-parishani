import { unwrap } from '@sepehr/api-client';
import { RELATIVE_RANGES, TICKET_STATUSES } from '@sepehr/contracts';
import {
  DateFilter,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  PageHeader,
  SelectField,
  showInstant,
  STAFF_TICKET_STATUS,
  TICKET_UNIT,
  tehranToday,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { filterOf, hrefOf, paramsOf, RANGE_LABEL } from '../report-params';
import {
  DeleteFilterButton,
  ExportForm,
  ExportLinkButton,
  PrintButton,
  SaveFilterForm,
} from './report-actions';
import { ReportRun } from './report-result';

export const metadata: Metadata = { title: 'گزارش | پنل داخلی سپهر' };

const EXPORT_STATE = { queued: 'در صف', ready: 'آماده', failed: 'ناموفق' } as const;

/**
 * One report (task 7-7; doc 17 §2, §4, §5): the one filter in the URL, the result as the API
 * gives it (scope and field masks applied there), the saved filters, the exports of exactly
 * this view, and a printable page.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ code }, query] = await Promise.all([params, searchParams]);
  const [session, api] = await Promise.all([getSession(), serverApi()]);
  const filter = filterOf(query);
  let data;
  try {
    const reports = await unwrap(api.GET('/api/v1/reporting/reports'));
    const report = reports.find((r) => r.code === code);
    if (!report) throw new Error('این گزارش برای نقش شما نیست.');
    const runParams = paramsOf(filter, report.params);
    const [filters, exports, topicList] = await Promise.all([
      unwrap(api.GET('/api/v1/reporting/filters', { params: { query: { reportCode: code } } })),
      unwrap(api.GET('/api/v1/reporting/exports')),
      unwrap(api.GET('/api/v1/reporting/ticket-topics')),
    ]);
    data = {
      report,
      runParams,
      filters,
      exports,
      topics: Object.fromEntries(topicList.map((t) => [t.code, t.title])),
    };
  } catch (error) {
    return (
      <>
        <PageHeader title="گزارش" />
        <Link href="/reports" className="text-accent underline">
          همه گزارش‌ها
        </Link>
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const { report, runParams, filters, exports, topics } = data;
  const takes = new Set(report.params);
  const shareUnits = can(session, 'reporting.share_filters')
    ? (session?.access.roles ?? [])
        .filter((r) => r in TICKET_UNIT)
        .map((r) => ({ value: r, label: TICKET_UNIT[r] ?? r }))
    : [];
  const mine = exports.filter((e) => e.reportCode === code).slice(0, 10);
  return (
    <>
      <PageHeader title={report.title} actions={<PrintButton />} />
      <Link href="/reports" className="text-accent underline print:hidden">
        همه گزارش‌ها
      </Link>

      {takes.size > 0 && (
        <div className="print:hidden">
          <FilterBar action={`/reports/${code}`} resetHref={`/reports/${code}`} label="فیلتر گزارش">
            {takes.has('range') && (
              <>
                <SelectField
                  id="range"
                  name="range"
                  label="بازه"
                  emptyLabel="بازه دلخواه (پایین)"
                  defaultValue={filter.relative ?? ''}
                  options={RELATIVE_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
                />
                <DateFilter
                  mode="range"
                  label="بازه دلخواه"
                  names={{ from: 'from', to: 'to' }}
                  today={tehranToday()}
                  defaultValue={
                    filter.from && filter.to ? { from: filter.from, to: filter.to } : null
                  }
                  hint="وقتی «بازه» خالی است به کار می‌رود."
                />
              </>
            )}
            {takes.has('unit') && (
              <SelectField
                id="unit"
                name="unit"
                label="واحد"
                emptyLabel="همه"
                defaultValue={filter.unit ?? ''}
                options={Object.entries(TICKET_UNIT).map(([value, label]) => ({ value, label }))}
              />
            )}
            {takes.has('status') && (
              <SelectField
                id="status"
                name="status"
                label="وضعیت"
                emptyLabel="همه"
                defaultValue={filter.status ?? ''}
                options={TICKET_STATUSES.map((s) => ({
                  value: s,
                  label: STAFF_TICKET_STATUS[s].label,
                }))}
              />
            )}
          </FilterBar>
        </div>
      )}

      <ReportRun
        key={JSON.stringify(runParams)}
        code={code}
        topics={topics}
        title={report.title}
        params={runParams}
        rangeText={
          filter.relative
            ? `بازه: ${RANGE_LABEL[filter.relative]}`
            : filter.from && filter.to
              ? 'بازه: دلخواه'
              : 'بی بازه'
        }
      />

      <div className="grid gap-4 lg:grid-cols-3 print:hidden">
        <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <h2 className="font-bold text-ink">خروجی</h2>
          <ExportForm code={code} params={runParams} />
        </section>
        <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <h2 className="font-bold text-ink">فیلترهای ذخیره‌شده</h2>
          {filters.length === 0 ? (
            <p className="text-[length:var(--text-sm)] text-ink-muted">فیلتری ذخیره نشده است.</p>
          ) : (
            <ul className="space-y-2">
              {filters.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2">
                  <Link href={hrefOf(code, f.conditions)} className="text-accent underline">
                    {f.name}
                  </Link>
                  {f.sharedUnit && (
                    <span className="text-[length:var(--text-xs)] text-ink-subtle">
                      مشترک با {TICKET_UNIT[f.sharedUnit] ?? f.sharedUnit}
                    </span>
                  )}
                  {f.mine && <DeleteFilterButton id={f.id} />}
                </li>
              ))}
            </ul>
          )}
          <SaveFilterForm code={code} conditions={runParams} units={shareUnits} />
        </section>
        <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <h2 className="font-bold text-ink">خروجی‌های من</h2>
          {mine.length === 0 ? (
            <p className="text-[length:var(--text-sm)] text-ink-muted">خروجی‌ای نگرفته‌اید.</p>
          ) : (
            <ul className="space-y-2 text-[length:var(--text-sm)]">
              {mine.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2">
                  <span>
                    {e.format.toUpperCase()}، {showInstant(e.createdAt)}، {EXPORT_STATE[e.status]}
                    {e.rowCount !== null ? `، ${faDigits(e.rowCount)} ردیف` : ''}
                  </span>
                  {e.status === 'ready' && <ExportLinkButton id={e.id} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
