import { unwrap } from '@sepehr/api-client';
import { TICKET_STATUSES } from '@sepehr/contracts';
import {
  buttonClass,
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  one,
  PageHeader,
  SelectField,
  STAFF_TICKET_STATUS,
  StatusBadge,
  TICKET_KIND,
  TICKET_UNIT,
  TicketDeadline,
  ticketUnit,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'تیکت‌ها | پنل داخلی سپهر' };

/**
 * The units' ticket queues (task 7-7; doc 17 §1): one's own units, or all for managers and the
 * read-only roles (the API decides). Past deadlines first, then the nearest; live ones unless
 * a status is chosen.
 */
export default async function TicketQueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const unit = one(params, 'unit') || undefined;
  const status = TICKET_STATUSES.find((s) => s === one(params, 'status'));
  const mine = one(params, 'mine') === 'true';
  const [session, api] = await Promise.all([getSession(), serverApi()]);
  let rows;
  try {
    rows = await unwrap(
      api.GET('/api/v1/tickets/queue', {
        params: {
          query: {
            ...(unit ? { unit } : {}),
            ...(status ? { status } : {}),
            ...(mine ? { mine: 'true' as const } : {}),
          },
        },
      }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="تیکت‌ها" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const now = new Date();
  const me = session?.me.accountId;
  const ordered = [...rows].sort((a, b) => Number(b.overdue) - Number(a.overdue));
  return (
    <>
      <PageHeader
        title="تیکت‌ها"
        description="صف تیکت واحدها، با مهلت پاسخ؛ گذشته از مهلت در بالای فهرست."
        actions={
          can(session, 'ticket.open_on_behalf') ? (
            <Link href="/tickets/new" className={buttonClass('primary')}>
              ثبت از طرف تماس‌گیرنده
            </Link>
          ) : undefined
        }
      />
      <FilterBar action="/tickets" resetHref="/tickets" label="فیلتر تیکت‌ها">
        <SelectField
          id="unit"
          name="unit"
          label="واحد"
          emptyLabel="واحدهای من"
          defaultValue={unit ?? ''}
          options={Object.entries(TICKET_UNIT).map(([value, label]) => ({ value, label }))}
        />
        <SelectField
          id="status"
          name="status"
          label="وضعیت"
          emptyLabel="همه تیکت‌های باز"
          defaultValue={status ?? ''}
          options={TICKET_STATUSES.map((s) => ({ value: s, label: STAFF_TICKET_STATUS[s].label }))}
        />
        <SelectField
          id="mine"
          name="mine"
          label="کارشناس"
          emptyLabel="همه"
          defaultValue={mine ? 'true' : ''}
          options={[{ value: 'true', label: 'فقط سپرده به من' }]}
        />
      </FilterBar>
      <DataTable
        caption="صف تیکت"
        rows={ordered}
        rowKey={(t) => t.id}
        empty={<EmptyState title="تیکتی در این صف نیست." />}
        columns={[
          {
            key: 'number',
            header: 'شماره',
            cell: (t) => (
              <Link href={`/tickets/${t.id}`} className="text-accent underline">
                {TICKET_KIND[t.kind]} {faDigits(t.number)}
              </Link>
            ),
          },
          { key: 'subject', header: 'عنوان', cell: (t) => t.subject },
          { key: 'unit', header: 'واحد', cell: (t) => ticketUnit(t.unit) },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (t) => (
              <StatusBadge tone={STAFF_TICKET_STATUS[t.status].tone}>
                {STAFF_TICKET_STATUS[t.status].label}
              </StatusBadge>
            ),
          },
          {
            key: 'due',
            header: 'مهلت پاسخ',
            cell: (t) => <TicketDeadline dueAt={t.dueAt} paused={t.paused} now={now} />,
          },
          {
            key: 'assignee',
            header: 'کارشناس',
            cell: (t) =>
              t.assigneeAccountId === null
                ? 'بی کارشناس'
                : t.assigneeAccountId === me
                  ? 'شما'
                  : t.assigneeAccountId.slice(0, 8),
          },
        ]}
      />
    </>
  );
}
