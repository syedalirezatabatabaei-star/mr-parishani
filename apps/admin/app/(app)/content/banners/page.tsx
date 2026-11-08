import { unwrap } from '@sepehr/api-client';
import type { BannerView } from '@sepehr/contracts';
import {
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  tehranToday,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { DecideVersion, ProposeBanner } from '../content-forms';
import { ContentNav } from '../content-nav';
import { BANNER_AUDIENCE, BANNER_TONE, CONTENT_STATUS } from '../labels';

export const metadata: Metadata = { title: 'بنرهای پیشخوان | پنل داخلی سپهر' };

function Version({ v, mine, decide }: { v: BannerView; mine: boolean; decide: boolean }) {
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="figures text-ink-muted">نسخه {faDigits(v.version)}</span>
        <StatusBadge tone={CONTENT_STATUS[v.status].tone}>
          {CONTENT_STATUS[v.status].label}
        </StatusBadge>
        {!v.active && <StatusBadge tone="neutral">غیرفعال</StatusBadge>}
      </div>
      <p className="font-bold">{v.title}</p>
      <p className="text-[length:var(--text-sm)]">{v.body}</p>
      <p className="figures text-[length:var(--text-xs)] text-ink-muted">
        {BANNER_TONE[v.tone]} · {v.audiences.map((a) => BANNER_AUDIENCE[a]).join('، ')} · از{' '}
        {showInstant(v.startsAt)}
        {v.endsAt ? ` تا ${showInstant(v.endsAt)}` : ''} · {faDigits(v.displaySeconds)} ثانیه ·
        ترتیب {faDigits(v.sortOrder)}
        {v.linkHref ? ` · دکمه «${v.linkLabel ?? ''}» به ${v.linkHref}` : ''}
      </p>
      {v.hasImage && (
        // eslint-disable-next-line @next/next/no-img-element -- served by the API, already small
        <img
          src={`/api/v1/config/content/banners/${v.id}/image`}
          alt={`تصویر بنر ${v.title}`}
          className="h-24 rounded-md object-cover"
        />
      )}
      <p className="text-[length:var(--text-xs)] text-ink-subtle">دلیل: {v.reason}</p>
      {v.decisionReason && (
        <p className="text-[length:var(--text-xs)] text-ink-subtle">
          دلیل تصمیم: {v.decisionReason}
        </p>
      )}
      {v.status === 'pending' && decide && <DecideVersion kind="banners" id={v.id} mine={mine} />}
    </div>
  );
}

/**
 * The desk's turning banners (owner 1405/08/10): every banner with its versions, the one in
 * force first; a new banner or a new version proposed by the system admin, decided by support
 * or another system admin. At most five run at once for an audience.
 */
export default async function BannersPage() {
  const [session, api] = await Promise.all([getSession(), serverApi()]);
  let all;
  try {
    all = await unwrap(api.GET('/api/v1/config/content/banners'));
  } catch (error) {
    return (
      <>
        <PageHeader title="مدیریت محتوای پیشخوان" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const propose = can(session, 'config.propose_content');
  const decide = can(session, 'config.approve_content');
  const me = session?.me.accountId;
  const groups = new Map<string, BannerView[]>();
  for (const v of all) groups.set(v.bannerKey, [...(groups.get(v.bannerKey) ?? []), v]);
  const today = tehranToday();
  return (
    <>
      <PageHeader
        title="مدیریت محتوای پیشخوان"
        description="بنرهای چرخان پیشخوان هر مخاطب؛ هر تغییر نسخه تازه‌ای است که نفر دوم تأیید می‌کند."
      />
      <ContentNav current="/content/banners" />
      {[...groups.values()].length === 0 ? (
        <EmptyState title="هنوز بنری نیست." />
      ) : (
        <ul className="space-y-4" aria-label="بنرها">
          {[...groups.values()].map((versions) => {
            const inForce = versions.find((v) => v.status === 'approved');
            const head = versions[0];
            if (!head) return null;
            return (
              <li
                key={head.bannerKey}
                className="space-y-3 rounded-lg border border-border bg-surface p-4"
              >
                <h2 className="font-bold">
                  {inForce?.title ?? head.title}
                  {inForce ? '' : ' (هنوز تأییدنشده)'}
                </h2>
                <div className="grid gap-3 lg:grid-cols-2">
                  {versions.slice(0, 4).map((v) => (
                    <Version key={v.id} v={v} mine={v.proposedBy === me} decide={decide} />
                  ))}
                </div>
                {propose && (
                  <details>
                    <summary className="cursor-pointer text-accent">
                      پیشنهاد نسخه تازه این بنر
                    </summary>
                    <div className="pt-3">
                      <ProposeBanner today={today} current={inForce ?? head} />
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {propose && (
        <section aria-label="بنر تازه" className="space-y-2">
          <h2 className="font-bold">بنر تازه</h2>
          <ProposeBanner today={today} />
        </section>
      )}
    </>
  );
}
