import { unwrap } from '@sepehr/api-client';
import {
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  rial,
  SERVICE_STATUS,
  showInstant,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../../lib/server-api';
import { DeliverCode } from './deliver-code';

export const metadata: Metadata = {
  title: 'مجوز خدمت | پنل مرکز',
  robots: { index: false, follow: false },
};

/**
 * One service authorization (doc 12 §6; task 4-7): what it authorized, until when, and the
 * patient's code to record it. The code is typed here and sent once; it is never shown,
 * stored or logged by the page.
 */
export default async function AuthorizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  let a;
  try {
    a = await unwrap(api.GET('/api/v1/service/authorizations/{id}', { params: { path: { id } } }));
  } catch (error) {
    return (
      <>
        <PageHeader title="مجوز خدمت" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const status = SERVICE_STATUS[a.status];
  return (
    <>
      <PageHeader title="مجوز خدمت" />
      <p className="flex flex-wrap gap-3">
        <Link href="/panel/patients" className="text-accent underline">
          بیماران اعتباری
        </Link>
        <Link href="/panel/authorizations" className="text-accent underline">
          تاریخچه خدمات
        </Link>
      </p>
      <dl className="grid gap-2 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
        <div>
          <dt className="text-ink-muted">وضعیت</dt>
          <dd>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">مبلغ</dt>
          <dd>
            <span className="figures font-bold">{rial(a.amountRial)}</span>
            <br />
            <span className="figures text-ink-muted">{toman(a.amountRial)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">صدور</dt>
          <dd className="figures">{showInstant(a.issuedAt)}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">اعتبار مجوز تا</dt>
          <dd className="figures">{showInstant(a.expiresAt)}</dd>
        </div>
        {a.deliveredAt && (
          <div>
            <dt className="text-ink-muted">ثبت خدمت</dt>
            <dd className="figures">{showInstant(a.deliveredAt)}</dd>
          </div>
        )}
        {a.finalizedAt && (
          <div>
            <dt className="text-ink-muted">قطعی شدن</dt>
            <dd className="figures">{showInstant(a.finalizedAt)}</dd>
          </div>
        )}
        {a.cancelReason && (
          <div className="sm:col-span-2">
            <dt className="text-ink-muted">دلیل لغو</dt>
            <dd>{a.cancelReason}</dd>
          </div>
        )}
      </dl>
      {a.status === 'code_sent' && (
        <>
          <p className="text-ink-muted">
            تلاش مانده: <span className="figures">{faDigits(a.attemptsLeft)}</span> · ارسال مانده:{' '}
            <span className="figures">{faDigits(a.sendsLeft)}</span>
          </p>
          <DeliverCode id={a.id} sendsLeft={a.sendsLeft} />
        </>
      )}
      {a.status === 'finalized' && <Notice tone="success">خدمت ثبت و قطعی شد.</Notice>}
      {a.status === 'delivered' && (
        <Notice tone="success">خدمت ثبت شد و پس از مهلت اعتراض قطعی می‌شود.</Notice>
      )}
    </>
  );
}
