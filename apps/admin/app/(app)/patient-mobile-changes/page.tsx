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
import { serverApi } from '../../../lib/server-api';
import { ChangeDecision } from './change-decision';
import { ProposeChange } from './propose-change';

export const metadata: Metadata = { title: 'تغییر شماره بیمار | پنل داخلی سپهر' };

/**
 * ف۱۲ ب۲ (owner 1405/07/26): a patient whose previous mobile is lost, by two people as 0085.
 * The first holder of `identity.change_patient_mobile` finds the account by its current
 * mobile, sends a code to the new one, and proposes with the code the patient reads back and
 * the evidence seen; a second, never the first, approves; refusing takes one. The last four
 * digits only, from the API. Off until launch (`identity.patient_mobile_change`).
 */
export default async function PatientMobileChangesPage() {
  const api = await serverApi();
  const [list] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/identity/patient-mobile-changes')),
  ]);
  return (
    <>
      <PageHeader
        title="تغییر شماره بیمار"
        description="برای بیماری که گوشی یا سیم‌کارت قبلی را ندارد: پیشنهاد با کد شماره تازه و مدرک، و تأیید نفر دوم. همه نشست‌های بیمار بسته می‌شود و به شماره قبلی پیامک می‌رود."
      />
      <section aria-labelledby="propose-title" className="mb-8 max-w-xl space-y-3">
        <h2 id="propose-title" className="text-[length:var(--text-lg)] font-bold">
          پیشنهاد تازه (نفر اول)
        </h2>
        <ProposeChange />
      </section>
      <section aria-labelledby="queue-title" className="space-y-3">
        <h2 id="queue-title" className="text-[length:var(--text-lg)] font-bold">
          در انتظار نفر دوم
        </h2>
        {list.status === 'rejected' ? (
          <Notice tone="danger">{errorMessage(list.reason)}</Notice>
        ) : (
          <DataTable
            caption="درخواست‌های تغییر شماره در انتظار تأیید"
            rows={list.value}
            rowKey={(r) => r.id}
            empty={<EmptyState title="درخواستی در انتظار تأیید نیست." />}
            columns={[
              {
                key: 'from',
                header: 'شماره قبلی',
                cell: (r) => <span dir="ltr">{faDigits(`…${r.fromLastFour}`)}</span>,
              },
              {
                key: 'to',
                header: 'شماره تازه',
                cell: (r) => <span dir="ltr">{faDigits(`…${r.toLastFour}`)}</span>,
              },
              {
                key: 'at',
                header: 'پیشنهاد در',
                cell: (r) => <time dateTime={r.requestedAt}>{showInstant(r.requestedAt)}</time>,
              },
              { key: 'evidence', header: 'مدرک دیده‌شده', cell: (r) => faDigits(r.evidence) },
              { key: 'reason', header: 'دلیل', cell: (r) => faDigits(r.reason) },
              {
                key: 'by',
                header: 'پیشنهاددهنده',
                cell: (r) =>
                  r.requestedByMe ? (
                    <StatusBadge tone="neutral">خودتان</StatusBadge>
                  ) : (
                    <StatusBadge tone="info">همکار دیگر</StatusBadge>
                  ),
              },
              {
                key: 'decide',
                header: 'تصمیم',
                cell: (r) => <ChangeDecision id={r.id} mine={r.requestedByMe} />,
              },
            ]}
          />
        )}
      </section>
    </>
  );
}
