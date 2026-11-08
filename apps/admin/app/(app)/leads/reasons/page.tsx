import { unwrap } from '@sepehr/api-client';
import { CASH_ABANDONMENT_REASON } from '@sepehr/contracts';
import { DataTable, EmptyState, errorMessage, faDigits, Notice, PageHeader } from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { AddReason, EditReason, RetireReason } from './reason-forms';

export const metadata: Metadata = { title: 'علت‌های بستن پرونده | پنل داخلی سپهر' };

/**
 * The abandonment reasons (doc 05 §5): the list a case is closed with. The strategy manager
 * (`lead.manage_reasons`) adds, renames, reorders and retires; a code is never reused, and
 * `chose_cash` is never retired (the cash-service commission hangs on it). Each change with
 * a reason, in the audit. A retired reason leaves the list; closed cases keep theirs.
 */
export default async function ReasonsPage() {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const manage = can(session, 'lead.manage_reasons');
  const [list] = await Promise.allSettled([unwrap(api.GET('/api/v1/lead/abandonment-reasons'))]);
  const options =
    list.status === 'fulfilled'
      ? list.value.map((r) => ({ value: r.code, label: `${r.title} (${r.code})` }))
      : [];
  return (
    <>
      <PageHeader
        title="علت‌های بستن پرونده"
        description="فهرستی که مشاور پرونده را با آن می‌بندد. هر تغییر دلیل می‌خواهد و در سابقه ثبت می‌شود؛ کد هرگز دوباره به کار نمی‌رود."
      />
      <div className="space-y-6">
        {list.status === 'rejected' ? (
          <Notice tone="danger">{errorMessage(list.reason)}</Notice>
        ) : (
          <DataTable
            caption="علت‌های جاری"
            rows={list.value}
            rowKey={(r) => r.code}
            empty={<EmptyState title="علتی تعریف نشده است." />}
            columns={[
              { key: 'order', header: 'ترتیب', cell: (r) => faDigits(String(r.sortOrder)) },
              { key: 'title', header: 'عنوان', cell: (r) => r.title },
              { key: 'code', header: 'کد', cell: (r) => <span dir="ltr">{r.code}</span> },
            ]}
          />
        )}
        {manage && list.status === 'fulfilled' && (
          <>
            <AddReason />
            {options.length > 0 && <EditReason options={options} />}
            {options.length > 1 && (
              <RetireReason options={options.filter((o) => o.value !== CASH_ABANDONMENT_REASON)} />
            )}
          </>
        )}
      </div>
    </>
  );
}
