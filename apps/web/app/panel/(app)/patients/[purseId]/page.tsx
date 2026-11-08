import { unwrap } from '@sepehr/api-client';
import { errorMessage, Notice, PageHeader } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../../lib/server-api';
import { IssueAuthorization } from './issue-authorization';

export const metadata: Metadata = {
  title: 'صدور مجوز خدمت | پنل مرکز',
  robots: { index: false, follow: false },
};

/**
 * Authorizing a service for one funded patient (doc 12 §6.1; task 4-7): the lines of their
 * proforma, each in one live authorization only (owner, پ۷). The sum is reserved on the
 * purse; more than the patient can use is refused whole, never reduced (owner, پ۶).
 */
export default async function IssueAuthorizationPage({
  params,
}: {
  params: Promise<{ purseId: string }>;
}) {
  const { purseId } = await params;
  const api = await serverApi();
  let view;
  try {
    view = await unwrap(
      api.GET('/api/v1/service/patients/{purseId}/lines', { params: { path: { purseId } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="صدور مجوز خدمت" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="صدور مجوز خدمت"
        description={view.patientName ? `بیمار: ${view.patientName}` : undefined}
      />
      <p>
        <Link href="/panel/patients" className="text-accent underline">
          بازگشت به بیماران اعتباری
        </Link>
      </p>
      {view.allowed ? (
        <IssueAuthorization purseId={purseId} lines={view.lines} />
      ) : (
        <Notice tone="warning">برای این بیمار اکنون مجوز خدمت صادر نمی‌شود.</Notice>
      )}
    </>
  );
}
