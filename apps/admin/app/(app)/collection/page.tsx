import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  TASK_KIND,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { DecideTask } from './collection-actions';

export const metadata: Metadata = { title: 'صف معوقات | پنل داخلی سپهر' };

const BUCKETS = ['۱ تا ۳۰ روز', '۳۱ تا ۶۰ روز', '۶۱ تا ۹۰ روز', 'بیش از ۹۰ روز'];

/**
 * The overdue queue (task 6-7; doc 15 §5): one's own or all, by bucket of days past due, never
 * the treatment, the doctor or the center. The collection manager also sees the stage 3 and 4
 * proposals waiting for their decision (never their own).
 */
export default async function CollectionQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const bucket = typeof params['bucket'] === 'string' ? Number(params['bucket']) : undefined;
  const mine = params['mine'] === 'true';
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const reads = can(session, 'collection.read_queue');
  const decides = can(session, 'collection.decide_escalation');
  let rows;
  let proposals;
  try {
    [rows, proposals] = await Promise.all([
      reads
        ? unwrap(
            api.GET('/api/v1/collection/queue', {
              params: {
                query: {
                  ...(bucket !== undefined && Number.isInteger(bucket) ? { bucket } : {}),
                  ...(mine ? { mine: 'true' as const } : {}),
                },
              },
            }),
          )
        : Promise.resolve([]),
      decides ? unwrap(api.GET('/api/v1/collection/tasks/proposed')) : Promise.resolve([]),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="صف معوقات" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="صف معوقات"
        description="پرونده‌های معوق، اقدام‌ها و وعده‌ها؛ بی هیچ اطلاعات درمان، پزشک یا مرکز."
      />
      {decides && (
        <DataTable
          caption="پیشنهادهای منتظر تصمیم شما (مرحله ۳ و ۴)"
          rows={proposals}
          rowKey={(r) => r.taskId}
          empty={<EmptyState title="پیشنهادی منتظر تصمیم نیست." />}
          columns={[
            {
              key: 'at',
              header: 'پیشنهاد',
              cell: (r) => (r.proposedAt ? showInstant(r.proposedAt) : '—'),
            },
            { key: 'kind', header: 'کار', cell: (r) => TASK_KIND[r.kind] },
            { key: 'note', header: 'توضیح کارشناس', cell: (r) => r.proposalNote ?? '—' },
            {
              key: 'item',
              header: 'پرونده',
              cell: (r) => (
                <Link href={`/collection/${r.itemId}`} className="text-accent underline">
                  باز کردن
                </Link>
              ),
            },
            { key: 'decide', header: 'تصمیم', cell: (r) => <DecideTask id={r.taskId} /> },
          ]}
        />
      )}
      {reads && (
        <>
          <nav aria-label="فیلتر صف" className="flex flex-wrap gap-3">
            <Link
              href="/collection"
              className="text-accent underline"
              aria-current={!mine && bucket === undefined ? 'page' : undefined}
            >
              همه
            </Link>
            <Link
              href="/collection?mine=true"
              className="text-accent underline"
              aria-current={mine ? 'page' : undefined}
            >
              فقط پرونده‌های من
            </Link>
            {BUCKETS.map((label, i) => (
              <Link
                key={label}
                href={`/collection?bucket=${String(i)}`}
                className="text-accent underline"
                aria-current={bucket === i ? 'page' : undefined}
              >
                {label}
              </Link>
            ))}
            <a href="/api/v1/collection/queue.csv" className="text-accent underline">
              خروجی CSV
            </a>
          </nav>
          <DataTable
            caption="پرونده‌های معوق"
            rows={rows}
            rowKey={(r) => r.itemId}
            empty={<EmptyState title="پرونده معوقی در این صف نیست." />}
            columns={[
              {
                key: 'name',
                header: 'وام‌گیرنده',
                cell: (r) => (
                  <span className="space-x-2">
                    <Link href={`/collection/${r.itemId}`} className="text-accent underline">
                      {r.borrowerName ?? 'بی‌نام'}
                    </Link>
                    {r.borrowerHeld && (
                      <StatusBadge tone="neutral">فوت یا ازکارافتادگی</StatusBadge>
                    )}
                  </span>
                ),
              },
              {
                key: 'mobile',
                header: 'موبایل',
                cell: (r) => (
                  <bdi dir="ltr" className="figures">
                    {r.borrowerMobile ? faDigits(`0${r.borrowerMobile}`) : '—'}
                  </bdi>
                ),
              },
              {
                key: 'days',
                header: 'روز معوق',
                cell: (r) => faDigits(r.maxDaysPastDue),
                numeric: true,
              },
              {
                key: 'count',
                header: 'قسط معوق',
                cell: (r) => faDigits(r.overdueInstallments),
                numeric: true,
              },
              {
                key: 'rial',
                header: 'مبلغ معوق',
                cell: (r) => toman(r.overdueRial),
                numeric: true,
              },
              {
                key: 'tasks',
                header: 'کار باز',
                cell: (r) => faDigits(r.openTasks),
                numeric: true,
              },
              { key: 'opened', header: 'ورود به صف', cell: (r) => showInstant(r.openedAt) },
            ]}
          />
        </>
      )}
    </>
  );
}
