import { unwrap } from '@sepehr/api-client';
import {
  CAMPAIGN_FILTER,
  CAMPAIGN_STATE,
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
} from '@sepehr/ui';
import { templateFields } from '@sepehr/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { NewCampaign } from './campaign-forms';

export const metadata: Metadata = { title: 'ارسال گروهی | پنل داخلی سپهر' };

/**
 * Bulk SMS (task 6-5; doc 15 §7): made from a named filter and a template, previewed, approved
 * by a second person (above the threshold only the strategy manager), sent gradually.
 */
export default async function CampaignsPage() {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  let campaigns;
  let templates;
  try {
    [campaigns, templates] = await Promise.all([
      unwrap(api.GET('/api/v1/notification/campaigns')),
      can(session, 'notification.manage_templates')
        ? unwrap(api.GET('/api/v1/notification/sms-templates'))
        : Promise.resolve([]),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="ارسال گروهی" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  // Owner: promotional campaigns stay off until unsubscribing is built; urgent never.
  const offered = templates.filter(
    (t) => t.category === 'transactional' && t.audience !== 'doctor' && t.audience !== 'staff',
  );
  return (
    <>
      <PageHeader
        title="ارسال گروهی"
        description="فیلتر نام‌دار، پیش‌نمایش، تأیید نفر دوم و ارسال تدریجی؛ هر گیرنده یک پیام."
      />
      {can(session, 'notification.manage_campaigns') && (
        <NewCampaign
          templates={offered.map((t) => ({
            code: t.code,
            audience: t.audience,
            fields: templateFields(t.body),
            label: `${t.code} (نسخه ${faDigits(t.version)})`,
          }))}
        />
      )}
      <DataTable
        caption="کمپین‌ها"
        rows={campaigns}
        rowKey={(c) => c.id}
        empty={<EmptyState title="کمپینی نیست." />}
        columns={[
          {
            key: 'name',
            header: 'نام',
            cell: (c) => (
              <Link href={`/sms/campaigns/${c.id}`} className="text-accent underline">
                {c.name}
              </Link>
            ),
          },
          {
            key: 'filter',
            header: 'فیلتر',
            cell: (c) =>
              (CAMPAIGN_FILTER as Readonly<Record<string, string | undefined>>)[c.filterCode] ??
              c.filterCode,
          },
          {
            key: 'n',
            header: 'گیرندگان',
            cell: (c) => (c.recipientCount === null ? '—' : faDigits(c.recipientCount)),
            numeric: true,
          },
          {
            key: 'state',
            header: 'وضعیت',
            cell: (c) => (
              <StatusBadge tone={CAMPAIGN_STATE[c.status].tone}>
                {CAMPAIGN_STATE[c.status].label}
              </StatusBadge>
            ),
          },
          { key: 'at', header: 'ساخت', cell: (c) => showInstant(c.createdAt) },
        ]}
      />
    </>
  );
}
