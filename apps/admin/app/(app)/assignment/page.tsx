import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  defined,
  EmptyState,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  one,
  PageHeader,
  SelectField,
  showInstant,
  TextField,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { getCities } from '../../../lib/cities';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { AgentSettings, SharesEditor } from './shares-editor';

export const metadata: Metadata = { title: 'تخصیص سرنخ و پرونده | پنل داخلی سپهر' };

/** The team queues (doc 05 §6, doc 10, doc 15, doc 17); another code can be typed. */
const QUEUES = [
  { value: 'advisory', label: 'مشاوره (سرنخ‌های تازه)' },
  { value: 'existing_customers', label: 'مشتریان فعلی' },
  { value: 'completion', label: 'تکمیل پرونده' },
  { value: 'credit', label: 'کارشناسی اعتبار' },
  { value: 'committee', label: 'کمیته' },
  { value: 'collection', label: 'وصول' },
  { value: 'ticket_support', label: 'تیکت پشتیبانی' },
];
const CODE = /^[a-z][a-z0-9_]{1,62}$/;
const PRESENCE_LABEL = { present: 'حاضر', on_leave: 'مرخصی', absent: 'غایب' } as const;
const DAY_MS = 86_400_000;

/** The report's window: the thirty days up to now. */
function lastThirtyDays() {
  const now = Date.now();
  return { from: new Date(now - 30 * DAY_MS).toISOString(), to: new Date(now).toISOString() };
}

/**
 * The strategy manager's assignment page (owner 1405/07/24; doc 05 §6): a queue's shares in
 * force (per city and treatment field if chosen), a new version of them, each agent's
 * presence and cap, and target against actual over the last thirty days. Through the lead
 * API only; each change audited there.
 */
export default async function AssignmentPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const typed = one(params, 'other')?.trim() ?? '';
  const queueCode = CODE.test(typed) ? typed : (one(params, 'queue') ?? 'advisory');
  const cityCode = one(params, 'city') || null;
  const fieldCode = one(params, 'field') || null;
  const [api, session, cities] = await Promise.all([serverApi(), getSession(), getCities()]);
  const mayManage = can(session, 'lead.manage_assignment');
  const mayReport = can(session, 'lead.read_distribution_report');
  const period = lastThirtyDays();
  const [shares, fields, report] = await Promise.allSettled([
    mayManage
      ? unwrap(
          api.GET('/api/v1/lead/assignment/shares', {
            params: {
              query: {
                queueCode,
                ...defined({
                  cityCode: cityCode ?? undefined,
                  treatmentFieldCode: fieldCode ?? undefined,
                }),
              },
            },
          }),
        )
      : Promise.resolve(null),
    unwrap(api.GET('/api/v1/catalog/fields')),
    mayReport
      ? unwrap(
          api.GET('/api/v1/lead/assignment/distribution', {
            params: {
              query: {
                queueCode,
                ...period,
              },
            },
          }),
        )
      : Promise.resolve([]),
  ]);
  const current = shares.status === 'fulfilled' ? (shares.value ?? null) : null;
  const names = new Map(current?.shares.map((s) => [s.accountId, s.name ?? s.accountId]) ?? []);

  return (
    <>
      <PageHeader
        title="تخصیص سرنخ و پرونده"
        description="سهم هر کارشناس از هر صف، حضور و سقف، و مقایسه هدف با واقعی. هر نسخه در سابقه ثبت می‌شود و شمارش از نو شروع می‌شود."
      />
      <FilterBar action="/assignment" label="انتخاب صف" submitLabel="نمایش">
        <SelectField id="queue" name="queue" label="صف" defaultValue={queueCode} options={QUEUES} />
        <TextField id="other" name="other" label="کد صف دیگر" dir="ltr" defaultValue={typed} />
        <SelectField
          id="city"
          name="city"
          label="شهر"
          emptyLabel="همه"
          defaultValue={cityCode ?? ''}
          options={cities.map((c) => ({ value: c.code, label: c.name }))}
        />
        <SelectField
          id="field"
          name="field"
          label="رشته درمان"
          emptyLabel="همه"
          defaultValue={fieldCode ?? ''}
          options={
            fields.status === 'fulfilled'
              ? fields.value.map((f) => ({ value: f.code, label: f.name }))
              : []
          }
        />
      </FilterBar>

      <div className="space-y-6">
        {mayManage &&
          (shares.status === 'rejected' ? (
            <Notice tone="danger">{errorMessage(shares.reason)}</Notice>
          ) : (
            <>
              <DataTable
                caption={`سهم‌های جاری صف ${queueCode}`}
                rows={current?.shares ?? []}
                rowKey={(s) => s.accountId}
                empty={<EmptyState title="این صف هنوز سهمی ندارد." />}
                columns={[
                  { key: 'name', header: 'کارشناس', cell: (s) => s.name ?? '—' },
                  {
                    key: 'percent',
                    header: 'سهم',
                    cell: (s) => `${faDigits(String(s.percent))}٪`,
                  },
                  {
                    key: 'inForce',
                    header: 'حضور و سقف جاری',
                    cell: (s) =>
                      `${PRESENCE_LABEL[s.presence]}؛ ${
                        s.maxOpenCases === null
                          ? 'بی‌سقف'
                          : `سقف ${faDigits(String(s.maxOpenCases))} پرونده باز`
                      }`,
                  },
                  {
                    key: 'settings',
                    header: 'تغییر حضور و سقف',
                    cell: (s) => (
                      <AgentSettings
                        accountId={s.accountId}
                        name={s.name ?? ''}
                        presence={s.presence}
                        maxOpenCases={s.maxOpenCases}
                      />
                    ),
                  },
                ]}
              />
              {current && (
                <p className="text-[length:var(--text-sm)] text-ink-muted">
                  نسخه جاری از {showInstant(current.effectiveAt)}
                </p>
              )}
              <SharesEditor
                key={current?.versionId ?? 'none'}
                queueCode={queueCode}
                cityCode={cityCode}
                treatmentFieldCode={fieldCode}
                initial={(current?.shares ?? []).map((s) => ({
                  accountId: s.accountId,
                  name: s.name,
                  percent: s.percent,
                }))}
              />
            </>
          ))}

        {mayReport &&
          (report.status === 'rejected' ? (
            <Notice tone="danger">{errorMessage(report.reason)}</Notice>
          ) : (
            <DataTable
              caption="هدف و واقعی، سی روز گذشته"
              rows={report.value.flatMap((v) =>
                v.agents.map((a) => ({ ...a, version: v.versionId, from: v.effectiveAt })),
              )}
              rowKey={(r) => `${r.version}-${r.accountId}`}
              empty={<EmptyState title="در سی روز گذشته چیزی از این صف تخصیص نیافته است." />}
              columns={[
                {
                  key: 'version',
                  header: 'نسخه از',
                  cell: (r) => <time dateTime={r.from}>{showInstant(r.from)}</time>,
                },
                {
                  key: 'agent',
                  header: 'کارشناس',
                  cell: (r) => names.get(r.accountId) ?? r.accountId,
                },
                {
                  key: 'target',
                  header: 'هدف',
                  cell: (r) => `${faDigits(String(r.targetPercent))}٪`,
                },
                { key: 'received', header: 'دریافتی', cell: (r) => faDigits(String(r.received)) },
                {
                  key: 'actual',
                  header: 'واقعی',
                  cell: (r) => `${faDigits((r.actualBasisPoints / 100).toFixed(2))}٪`,
                },
              ]}
            />
          ))}
      </div>
    </>
  );
}
