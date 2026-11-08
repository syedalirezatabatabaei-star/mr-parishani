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
import { PROFORMA_STATUS } from '../../../../lib/credit';
import { serverApi } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'پیش‌فاکتورهای من | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/** The patient's proformas (doc 10 §2): what each doctor proposed, to confirm or dispute. */
export default async function MyProformasPage() {
  const api = await serverApi();
  let proformas;
  try {
    proformas = await unwrap(api.GET('/api/v1/me/proformas'));
  } catch (error) {
    return (
      <>
        <PageHeader title="پیش‌فاکتورهای من" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const shown = proformas.filter((p) => p.status !== 'draft' && p.status !== 'superseded');
  return (
    <>
      <PageHeader
        title="پیش‌فاکتورهای من"
        description="پیش‌فاکتوری که پزشک صادر کرده را ببینید، تأیید کنید و برای آن اعتبار بگیرید."
      />
      {shown.length === 0 ? (
        <EmptyState title="هنوز پیش‌فاکتوری برای شما صادر نشده است." />
      ) : (
        <ul className="space-y-3" aria-label="فهرست پیش‌فاکتورها">
          {shown.map((p) => (
            <li key={p.id} className="space-y-2 rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-bold">
                  {p.placeName ?? 'پیش‌فاکتور'} · نسخه {faDigits(p.version)}
                </p>
                <StatusBadge tone={PROFORMA_STATUS[p.status].tone}>
                  {PROFORMA_STATUS[p.status].label}
                </StatusBadge>
              </div>
              <p className="figures">جمع: {toman(p.totalRial)}</p>
              {p.issuedAt && (
                <p className="text-[length:var(--text-sm)] text-ink-muted">
                  صدور: <span className="figures">{showInstant(p.issuedAt)}</span>
                </p>
              )}
              <Link href={`/me/proformas/${p.id}`} className="text-accent underline">
                مشاهده و پاسخ
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
