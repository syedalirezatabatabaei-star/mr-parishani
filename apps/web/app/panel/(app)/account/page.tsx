import { unwrap } from '@sepehr/api-client';
import {
  AccountSecurity,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { serverApi } from '../../../../lib/server-api';
import { VerifyMobile } from './verify-mobile';

export const metadata: Metadata = {
  title: 'حساب من | پنل مرکز',
  robots: { index: false, follow: false },
};

/**
 * The account's own mobile (task 4-6, technical task ف۴; page of task 4-7): proved by a code
 * sent to it, never only typed. A doctor's account is linked, and a center manager granted,
 * only with one; the system's SMS (a funded patient, for one) go to it.
 */
export default async function AccountPage() {
  const api = await serverApi();
  let mobile;
  try {
    mobile = await unwrap(api.GET('/api/v1/auth/mobile'));
  } catch (error) {
    return (
      <>
        <PageHeader title="حساب من" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader title="حساب من" description="موبایل حساب، تأییدشده با کد پیامکی." />
      <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
        <h2 className="font-bold">موبایل حساب</h2>
        {mobile.verified && mobile.mobileLastFour ? (
          <Notice tone="success">
            موبایل به‌پایان‌رسیده به{' '}
            <bdi className="figures">{faDigits(mobile.mobileLastFour)}</bdi> در{' '}
            <span className="figures">
              {mobile.verifiedAt ? showInstant(mobile.verifiedAt) : ''}
            </span>{' '}
            تأیید شده است.
          </Notice>
        ) : (
          <Notice tone="warning">موبایل این حساب هنوز تأیید نشده است.</Notice>
        )}
        <VerifyMobile verified={mobile.verified} />
      </section>
      <AccountSecurity />
    </>
  );
}
