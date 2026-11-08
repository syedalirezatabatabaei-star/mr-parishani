import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  Notice,
  one,
  PageHeader,
  showInstant,
  StatusBadge,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { cityNamer, getCities } from '../../../lib/cities';
import { CASE_STATUS, INTAKE_CHANNEL } from '../../../lib/leads';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { IntakeForm } from './lead-forms';

export const metadata: Metadata = { title: 'سرنخ‌ها و پرونده‌ها | پنل داخلی سپهر' };

/**
 * The advisor's page (owner 1405/07/24, go-live blocker م۹): their own cases (scope `own`;
 * a team queue, a city or everything for whoever holds that scope), open ones first by
 * default, and a lead entered by hand through the one intake (doc 05 §1).
 */
export default async function LeadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const all = one(params, 'all') === '1';
  const [api, session, cities, cityName] = await Promise.all([
    serverApi(),
    getSession(),
    getCities(),
    cityNamer(),
  ]);
  const mayIntake = can(session, 'lead.intake_manual');
  const [list, fields] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/lead/cases', { params: { query: { open: all ? 'false' : 'true' } } })),
    mayIntake ? unwrap(api.GET('/api/v1/catalog/fields')) : Promise.resolve([]),
  ]);
  const fieldOptions =
    fields.status === 'fulfilled'
      ? fields.value.map((f) => ({ value: f.code, label: f.name }))
      : [];
  const fieldName = (code: string) => fieldOptions.find((f) => f.value === code)?.label ?? code;

  return (
    <>
      <PageHeader
        title="سرنخ‌ها و پرونده‌ها"
        description="پرونده‌های واگذارشده به شما، ثبت سرنخ تازه، و نوبت برای بیمار از صفحه هر پرونده."
      />
      <div className="space-y-6">
        {mayIntake && (
          <IntakeForm
            fields={fieldOptions}
            cities={cities.map((c) => ({ value: c.code, label: c.name }))}
          />
        )}
        <p className="flex gap-3 text-[length:var(--text-sm)]">
          <Link
            href="/leads"
            aria-current={all ? undefined : 'page'}
            className="text-accent hover:underline aria-[current=page]:font-bold"
          >
            پرونده‌های باز
          </Link>
          <Link
            href="/leads?all=1"
            aria-current={all ? 'page' : undefined}
            className="text-accent hover:underline aria-[current=page]:font-bold"
          >
            همه پرونده‌ها
          </Link>
          {can(session, 'lead.manage_reasons') && (
            <Link href="/leads/reasons" className="ms-auto text-accent hover:underline">
              علت‌های بستن پرونده
            </Link>
          )}
        </p>
        {list.status === 'rejected' ? (
          <Notice tone="danger">{errorMessage(list.reason)}</Notice>
        ) : (
          <DataTable
            caption={all ? 'همه پرونده‌ها' : 'پرونده‌های باز'}
            rows={list.value}
            rowKey={(c) => c.id}
            empty={<EmptyState title="پرونده‌ای نیست." />}
            columns={[
              {
                key: 'status',
                header: 'وضعیت',
                cell: (c) => (
                  <StatusBadge tone={CASE_STATUS[c.status].tone}>
                    {CASE_STATUS[c.status].label}
                  </StatusBadge>
                ),
              },
              { key: 'field', header: 'رشته درمان', cell: (c) => fieldName(c.treatmentFieldCode) },
              {
                key: 'city',
                header: 'شهر',
                cell: (c) => (c.cityCode ? cityName(c.cityCode) : '—'),
              },
              {
                key: 'channel',
                header: 'از راه',
                cell: (c) => (
                  <>
                    {INTAKE_CHANNEL[c.channel]}
                    {c.isReturning && (
                      <>
                        {' '}
                        <StatusBadge tone="info">بازگشتی</StatusBadge>
                      </>
                    )}
                  </>
                ),
              },
              {
                key: 'created',
                header: 'ثبت',
                cell: (c) => <time dateTime={c.createdAt}>{showInstant(c.createdAt)}</time>,
              },
              {
                key: 'open',
                header: 'پرونده',
                cell: (c) => (
                  <Link href={`/leads/${c.id}`} className="font-medium text-accent hover:underline">
                    باز کردن
                  </Link>
                ),
              },
            ]}
          />
        )}
      </div>
    </>
  );
}
