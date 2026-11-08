import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  DISPATCH_STATE,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  SMS_CATEGORY,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { CancelScheduled, ConsentForm, ScheduleSms, TemplateForm } from './sms-forms';

export const metadata: Metadata = { title: 'پیامک | پنل داخلی سپهر' };

const AUDIENCE: Readonly<Record<string, string>> = {
  patient: 'بیمار',
  borrower: 'وام‌گیرنده',
  guarantor: 'ضامن',
  doctor: 'پزشک',
  staff: 'کارکنان',
};

/**
 * SMS (tasks 6-4 and 6-5; doc 15 §7): templates by version with the fields each recipient
 * may see; what was sent, scheduled or held back; consent to promotional SMS; one SMS at a
 * chosen Jalali moment. Bulk SMS on their own page. Mobiles are shown masked.
 */
export default async function SmsPage() {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const manages = can(session, 'notification.manage_templates');
  const reads = can(session, 'notification.read_dispatches');
  let templates;
  let dispatches;
  try {
    [templates, dispatches] = await Promise.all([
      manages ? unwrap(api.GET('/api/v1/notification/sms-templates')) : Promise.resolve([]),
      reads
        ? unwrap(api.GET('/api/v1/notification/sms-dispatches', { params: { query: {} } }))
        : Promise.resolve([]),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="پیامک" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="پیامک"
        description="قالب‌ها، ارسال زمان‌بندی‌شده، رضایت و گزارش؛ ارسال فقط در ساعات مجاز (جز کد ورود و خدمت)."
      />
      {(can(session, 'notification.manage_campaigns') ||
        can(session, 'notification.approve_campaigns')) && (
        <p>
          <Link href="/sms/campaigns" className="text-accent underline">
            ارسال گروهی (کمپین)
          </Link>
        </p>
      )}
      {manages && (
        <>
          <DataTable
            caption="قالب‌ها (آخرین نسخه هر کد)"
            rows={templates}
            rowKey={(t) => t.id}
            empty={<EmptyState title="قالبی نیست." />}
            columns={[
              { key: 'code', header: 'کد', cell: (t) => <bdi dir="ltr">{t.code}</bdi> },
              { key: 'v', header: 'نسخه', cell: (t) => faDigits(t.version), numeric: true },
              { key: 'aud', header: 'گیرنده', cell: (t) => AUDIENCE[t.audience] ?? t.audience },
              { key: 'cat', header: 'دسته', cell: (t) => SMS_CATEGORY[t.category] },
              { key: 'body', header: 'متن', cell: (t) => t.body },
              { key: 'seg', header: 'بخش', cell: (t) => faDigits(t.segments), numeric: true },
            ]}
          />
          <TemplateForm />
        </>
      )}
      {can(session, 'notification.schedule_sms') && <ScheduleSms />}
      {can(session, 'notification.manage_consent') && <ConsentForm />}
      {reads && (
        <DataTable
          caption="پیامک‌های اخیر"
          rows={dispatches}
          rowKey={(d) => d.id}
          empty={<EmptyState title="پیامکی ثبت نشده است." />}
          columns={[
            { key: 'at', header: 'ثبت', cell: (d) => showInstant(d.createdAt) },
            { key: 'tpl', header: 'قالب', cell: (d) => <bdi dir="ltr">{d.templateCode}</bdi> },
            {
              key: 'to',
              header: 'گیرنده',
              cell: (d) => (
                <bdi dir="ltr" className="figures">
                  {faDigits(d.mobileMasked)}
                </bdi>
              ),
            },
            { key: 'send', header: 'زمان ارسال', cell: (d) => showInstant(d.sendAfter) },
            {
              key: 'state',
              header: 'وضعیت',
              cell: (d) => (
                <StatusBadge tone={DISPATCH_STATE[d.status].tone}>
                  {DISPATCH_STATE[d.status].label}
                </StatusBadge>
              ),
            },
            {
              key: 'cancel',
              header: 'لغو',
              cell: (d) =>
                d.status === 'scheduled' &&
                d.staffScheduled &&
                can(session, 'notification.schedule_sms') ? (
                  <CancelScheduled id={d.id} />
                ) : (
                  '—'
                ),
            },
          ]}
        />
      )}
    </>
  );
}
