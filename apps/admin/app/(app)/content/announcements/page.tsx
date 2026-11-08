import { unwrap } from '@sepehr/api-client';
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
import { DecideVersion, ProposeAnnouncement } from '../content-forms';
import { ContentNav } from '../content-nav';
import { ANNOUNCEMENT_AUDIENCE, CONTENT_STATUS } from '../labels';

export const metadata: Metadata = { title: 'اطلاعیه‌ها | پنل داخلی سپهر' };

/**
 * The manual announcements of the bell (owner 1405/08/10): for everyone, patients, centers,
 * staff or one role, urgent or not, in a window; proposed and decided by two people.
 */
export default async function AnnouncementsPage() {
  const [session, api] = await Promise.all([getSession(), serverApi()]);
  let all;
  try {
    all = await unwrap(api.GET('/api/v1/config/content/announcements'));
  } catch (error) {
    return (
      <>
        <PageHeader title="مدیریت محتوای پیشخوان" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const me = session?.me.accountId;
  return (
    <>
      <PageHeader
        title="مدیریت محتوای پیشخوان"
        description="اطلاعیه‌هایی که در فهرست اعلان‌های زنگ هر مخاطب دیده می‌شوند."
      />
      <ContentNav current="/content/announcements" />
      {all.length === 0 ? (
        <EmptyState title="هنوز اطلاعیه‌ای نیست." />
      ) : (
        <ul className="space-y-3" aria-label="اطلاعیه‌ها">
          {all.map((a) => (
            <li key={a.id} className="space-y-2 rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-bold">{a.title}</p>
                <span className="figures text-ink-muted">نسخه {faDigits(a.version)}</span>
                <StatusBadge tone={CONTENT_STATUS[a.status].tone}>
                  {CONTENT_STATUS[a.status].label}
                </StatusBadge>
                {a.urgent && <StatusBadge tone="danger">فوری</StatusBadge>}
              </div>
              <p className="text-[length:var(--text-sm)]">{a.body}</p>
              <p className="figures text-[length:var(--text-xs)] text-ink-muted">
                {ANNOUNCEMENT_AUDIENCE[a.audience]}
                {a.roleCode ? ` (${a.roleCode})` : ''} · از {showInstant(a.startsAt)}
                {a.endsAt ? ` تا ${showInstant(a.endsAt)}` : ''} · دلیل: {a.reason}
              </p>
              {a.status === 'pending' && can(session, 'config.approve_content') && (
                <DecideVersion kind="announcements" id={a.id} mine={a.proposedBy === me} />
              )}
            </li>
          ))}
        </ul>
      )}
      {can(session, 'config.propose_content') && (
        <section aria-label="اطلاعیه تازه" className="space-y-2">
          <h2 className="font-bold">اطلاعیه تازه</h2>
          <ProposeAnnouncement today={tehranToday()} />
        </section>
      )}
    </>
  );
}
