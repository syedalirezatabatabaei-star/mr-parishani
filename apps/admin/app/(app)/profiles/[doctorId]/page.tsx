import { unwrap } from '@sepehr/api-client';
import type { ProfileVersionBody } from '@sepehr/contracts';
import { errorMessage, faDigits, Notice, PageHeader, showInstant } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { serverApi } from '../../../../lib/server-api';
import { ProfileDecision } from './profile-decision';

export const metadata: Metadata = { title: 'بررسی پروفایل | پنل داخلی سپهر' };

/** What a version says, as the public page would (doc 08 §10): read before deciding. */
function VersionContent({ title, version }: { title: string; version: ProfileVersionBody }) {
  const c = version.content;
  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-surface p-4"
      aria-label={title}
    >
      <h2 className="text-[length:var(--text-lg)] font-bold">
        {title} (نسخه {faDigits(version.versionNo)})
      </h2>
      <dl className="space-y-2 text-[length:var(--text-sm)]">
        <div>
          <dt className="text-ink-muted">عنوان تخصص</dt>
          <dd>{c.specialtyTitle ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">درباره پزشک</dt>
          <dd className="whitespace-pre-line">{c.biography ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">سوابق</dt>
          <dd>
            {c.history && c.history.length > 0 ? (
              <ul className="list-inside list-disc">
                {c.history.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">پیوندها</dt>
          <dd dir="ltr" className="text-start">
            {c.socials && c.socials.length > 0 ? c.socials.map((s) => s.url).join('، ') : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">عکس و ویدئو</dt>
          <dd>
            {c.photoAssetId ? 'عکس دارد' : 'بدون عکس'}، {c.video ? 'ویدئو دارد' : 'بدون ویدئو'}
          </dd>
        </div>
      </dl>
      {version.submittedAt && (
        <p className="text-[length:var(--text-xs)] text-ink-muted">
          ارسال: {showInstant(version.submittedAt)}
        </p>
      )}
    </section>
  );
}

/**
 * One profile in review: the version submitted beside the one published now, then the
 * specialist's decision with a reason (rule 9). The API refuses a reviewer outside the
 * doctor's cities (rule 13).
 */
export default async function ProfileReviewPage({
  params,
}: {
  params: Promise<{ doctorId: string }>;
}) {
  const { doctorId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(doctorId)) notFound();
  const api = await serverApi();
  const [profile] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/catalog/doctors/{id}/profile', { params: { path: { id: doctorId } } })),
  ]);
  if (profile.status === 'rejected') {
    return (
      <>
        <PageHeader title="بررسی پروفایل" />
        <Notice tone="danger">{errorMessage(profile.reason)}</Notice>
      </>
    );
  }
  const { open, published, slug } = profile.value;
  return (
    <>
      <PageHeader
        title="بررسی پروفایل"
        description={`/doctors/${slug}`}
        actions={
          <Link href="/profiles" className="text-accent underline">
            بازگشت به صف
          </Link>
        }
      />
      {open?.status === 'in_review' ? (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <VersionContent title="نسخه ارسال‌شده" version={open} />
            {published ? (
              <VersionContent title="نسخه منتشرشده فعلی" version={published} />
            ) : (
              <Notice tone="info">این پروفایل هنوز نسخه منتشرشده ندارد.</Notice>
            )}
          </div>
          <ProfileDecision versionId={open.id} />
        </>
      ) : (
        <Notice tone="info">نسخه‌ای از این پروفایل در انتظار بررسی نیست.</Notice>
      )}
    </>
  );
}
