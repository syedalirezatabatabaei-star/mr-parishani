import { unwrap } from '@sepehr/api-client';
import {
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CREDIT_STATUS } from '../../../../lib/credit';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'اعتبار درمان من | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/** The patient's and borrower's credit applications (doc 10 §4): state and next step. */
export default async function MyCreditPage() {
  const api = await serverApi();
  let applications;
  try {
    applications = await unwrap(api.GET('/api/v1/me/credit-applications'));
  } catch (error) {
    return (
      <>
        <PageHeader title="اعتبار درمان من" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader title="اعتبار درمان من" />
      <p>
        <Link href="/me/guarantees" className="text-accent underline">
          ضمانت‌هایی که برای دیگران پذیرفته‌اید
        </Link>
      </p>
      {applications.length === 0 ? (
        <EmptyState title="هنوز درخواست اعتباری ندارید.">
          <Link href="/me/proformas" className="text-accent underline">
            از پیش‌فاکتور تأییدشده درخواست اعتبار بدهید
          </Link>
        </EmptyState>
      ) : (
        <ul className="space-y-3" aria-label="درخواست‌های اعتبار">
          {applications.map((a) => (
            <li key={a.id} className="space-y-2 rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-bold">
                  {a.planTitle} · {faDigits(a.installmentCount)} قسط
                </p>
                <StatusBadge tone={CREDIT_STATUS[a.status].tone}>
                  {CREDIT_STATUS[a.status].label}
                </StatusBadge>
              </div>
              <p className="figures">مبلغ وام: {toman(a.approvedAmountRial ?? a.loanRial)}</p>
              <p className="text-[length:var(--text-sm)] text-ink-muted">
                ثبت: <span className="figures">{showInstant(a.createdAt)}</span>
              </p>
              <Link href={`/me/credit/${a.id}`} className="text-accent underline">
                پیگیری و تکمیل
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
