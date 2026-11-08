import { unwrap } from '@sepehr/api-client';
import {
  CAMPAIGN_EXCLUSION,
  CAMPAIGN_FILTER,
  CAMPAIGN_STATE,
  DISPATCH_STATE,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  toman,
} from '@sepehr/ui';
import type { CampaignExclusion, SmsDispatchStatus } from '@sepehr/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi } from '../../../../../lib/server-api';
import { ApproveCampaign, CampaignControls } from '../campaign-forms';

export const metadata: Metadata = { title: 'کمپین پیامک | پنل داخلی سپهر' };

/**
 * One campaign: what it is, the preview while a draft (count, exclusions by reason, a real
 * sample, the price), the approval by a second person, then its progress and report.
 */
export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  let campaign;
  try {
    const all = await unwrap(api.GET('/api/v1/notification/campaigns'));
    campaign = all.find((c) => c.id === id);
  } catch (error) {
    return (
      <>
        <PageHeader title="کمپین" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  if (!campaign) {
    return (
      <>
        <PageHeader title="کمپین" />
        <Notice tone="danger">کمپین پیدا نشد.</Notice>
      </>
    );
  }
  const draft = campaign.status === 'draft';
  const [preview, report] = await Promise.all([
    draft
      ? unwrap(
          api.GET('/api/v1/notification/campaigns/{id}/preview', { params: { path: { id } } }),
        ).catch(() => null)
      : Promise.resolve(null),
    draft
      ? Promise.resolve(null)
      : unwrap(
          api.GET('/api/v1/notification/campaigns/{id}/report', { params: { path: { id } } }),
        ).catch(() => null),
  ]);
  const excluded = (preview?.excluded ?? report?.excluded ?? {}) as Partial<
    Record<CampaignExclusion, number>
  >;
  const mine = campaign.createdBy === session?.me.accountId;

  return (
    <>
      <PageHeader title={`کمپین: ${campaign.name}`} />
      <p>
        <Link href="/sms/campaigns" className="text-accent underline">
          همه کمپین‌ها
        </Link>
      </p>
      <dl className="grid gap-2 sm:grid-cols-3">
        <div>
          <dt className="text-ink-muted">وضعیت</dt>
          <dd>
            <StatusBadge tone={CAMPAIGN_STATE[campaign.status].tone}>
              {CAMPAIGN_STATE[campaign.status].label}
            </StatusBadge>
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">فیلتر</dt>
          <dd>
            {(CAMPAIGN_FILTER as Readonly<Record<string, string | undefined>>)[
              campaign.filterCode
            ] ?? campaign.filterCode}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">قالب</dt>
          <dd>
            <bdi dir="ltr">{campaign.templateCode}</bdi> (نسخه {faDigits(campaign.templateVersion)})
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">آستانه دونفره این کمپین</dt>
          <dd className="figures">{faDigits(campaign.twoPersonThreshold)} گیرنده</dd>
        </div>
        <div>
          <dt className="text-ink-muted">شروع ارسال از</dt>
          <dd className="figures">{showInstant(campaign.sendFrom)}</dd>
        </div>
      </dl>
      {preview && (
        <section
          className="space-y-2 rounded-md border border-border p-3"
          aria-labelledby="preview-title"
        >
          <h2 id="preview-title" className="font-bold">
            پیش‌نمایش (اکنون)
          </h2>
          <p className="figures">
            {faDigits(preview.recipientCount)} گیرنده، {faDigits(preview.segments)} بخش، برآورد
            هزینه {toman(preview.costEstimateRial)}
          </p>
          {preview.sample && (
            <blockquote className="rounded-md bg-surface-muted p-3">{preview.sample}</blockquote>
          )}
          {preview.needsApproveCampaigns && (
            <Notice tone="warning">
              بالای آستانه است: فقط مدیر استراتژی (نه سازنده) تأیید می‌کند.
            </Notice>
          )}
        </section>
      )}
      {Object.keys(excluded).length > 0 && (
        <section aria-labelledby="excluded-title">
          <h2 id="excluded-title" className="font-bold">
            حذف‌شده‌ها
          </h2>
          <ul className="list-inside list-disc">
            {(Object.entries(excluded) as [CampaignExclusion, number][]).map(([why, n]) => (
              <li key={why} className="figures">
                {CAMPAIGN_EXCLUSION[why]}: {faDigits(n)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {draft &&
        (can(session, 'notification.manage_campaigns') ||
          can(session, 'notification.approve_campaigns')) &&
        (mine ? (
          <Notice tone="info">سازنده کمپین تأیید نمی‌کند؛ نفر دوم باید تأیید کند.</Notice>
        ) : (
          <ApproveCampaign id={id} />
        ))}
      {can(session, 'notification.manage_campaigns') && (
        <CampaignControls id={id} status={campaign.status} />
      )}
      {report && (
        <section className="space-y-2" aria-labelledby="report-title">
          <h2 id="report-title" className="font-bold">
            گزارش
          </h2>
          <p className="figures">
            در صف: {faDigits(report.recipients.pending)}، ارسال‌شده به صف پیامک:{' '}
            {faDigits(report.recipients.dispatched)}، لغوشده:{' '}
            {faDigits(report.recipients.cancelled)}
          </p>
          <ul className="flex flex-wrap gap-2">
            {(Object.entries(report.dispatches) as [SmsDispatchStatus, number][]).map(
              ([state, n]) => (
                <li key={state}>
                  <StatusBadge tone={DISPATCH_STATE[state].tone}>
                    {DISPATCH_STATE[state].label}: {faDigits(n)}
                  </StatusBadge>
                </li>
              ),
            )}
          </ul>
        </section>
      )}
    </>
  );
}
