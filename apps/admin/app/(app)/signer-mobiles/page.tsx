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
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { AskChange, DecideChange } from './signer-mobile-forms';

export const metadata: Metadata = { title: 'شماره امضاکنندگان | پنل داخلی سپهر' };

const STATUS = {
  open: { label: 'در انتظار تأیید', tone: 'warning' },
  approved: { label: 'تأییدشده، در انتظار اثر', tone: 'info' },
  refused: { label: 'ردشده', tone: 'neutral' },
  applied: { label: 'اعمال‌شده', tone: 'success' },
} as const;

/**
 * ADR-052 (owner 1405/08/02): a financial signer's mobile is where their SMS codes go. The CEO
 * and the system administrator change it, both approving, never its owner; when the owner is
 * one of them, two others approve. The new number counts 24 hours after the second approval;
 * the old one is told at once. Last four digits only.
 */
export default async function SignerMobilesPage() {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const me = session?.me.accountId ?? '';
  const mayAsk = can(session, 'identity.request_financial_mobile_change');
  const mayApprove = can(session, 'identity.approve_financial_mobile_change');
  const [list] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/identity/staff-mobile-changes')),
  ]);
  return (
    <>
      <PageHeader
        title="شماره امضاکنندگان مالی"
        description="کد تأیید هر امضای مالی به شماره خود امضاکننده پیامک می‌شود. تغییر این شماره با تأیید مدیرعامل و مدیر سیستم است، هرگز با خود شخص؛ شماره تازه ۲۴ ساعت پس از تأیید دوم اثر می‌کند و به شماره قبلی پیامک می‌رود."
      />
      {mayAsk ? (
        <section aria-labelledby="ask-title" className="mb-8 max-w-xl space-y-3">
          <h2 id="ask-title" className="text-[length:var(--text-lg)] font-bold">
            درخواست تازه
          </h2>
          <AskChange />
        </section>
      ) : null}
      <section aria-labelledby="queue-title" className="space-y-3">
        <h2 id="queue-title" className="text-[length:var(--text-lg)] font-bold">
          درخواست‌ها
        </h2>
        {list.status === 'rejected' ? (
          <Notice tone="danger">{errorMessage(list.reason)}</Notice>
        ) : (
          <DataTable
            caption="درخواست‌های تغییر شماره امضاکنندگان"
            rows={list.value}
            rowKey={(r) => r.id}
            empty={<EmptyState title="درخواستی نیست." />}
            columns={[
              {
                key: 'to',
                header: 'شماره تازه',
                cell: (r) => <span dir="ltr">{faDigits(`…${r.mobileLastFour}`)}</span>,
              },
              {
                key: 'at',
                header: 'درخواست در',
                cell: (r) => <time dateTime={r.requestedAt}>{showInstant(r.requestedAt)}</time>,
              },
              { key: 'reason', header: 'دلیل', cell: (r) => faDigits(r.reason) },
              {
                key: 'approvals',
                header: 'تأییدها',
                cell: (r) => faDigits(`${String(r.approvedBy.length)} از 2`),
              },
              {
                key: 'status',
                header: 'وضعیت',
                cell: (r) => (
                  <span className="space-y-1">
                    <StatusBadge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusBadge>
                    {r.effectiveAt && r.status === 'approved' ? (
                      <span className="block text-[length:var(--text-sm)]">
                        اثر از <time dateTime={r.effectiveAt}>{showInstant(r.effectiveAt)}</time>
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: 'decide',
                header: 'تصمیم',
                cell: (r) =>
                  r.status !== 'open' || !mayApprove ? (
                    '—'
                  ) : r.accountId === me ? (
                    <StatusBadge tone="neutral">شماره خودتان</StatusBadge>
                  ) : r.approvedBy.includes(me) ? (
                    <StatusBadge tone="neutral">تأیید کرده‌اید</StatusBadge>
                  ) : (
                    <DecideChange id={r.id} />
                  ),
              },
            ]}
          />
        )}
      </section>
    </>
  );
}
