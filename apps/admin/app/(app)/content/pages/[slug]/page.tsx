import { unwrap } from '@sepehr/api-client';
import { CONTENT_SLUG_TITLES, CONTENT_SLUGS, type ContentSlug } from '@sepehr/contracts';
import { errorMessage, faDigits, Notice, PageHeader, showInstant, StatusBadge } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can, getSession, serverApi } from '../../../../../lib/server-api';
import { DecideVersion } from '../../content-forms';
import { CONTENT_STATUS } from '../../labels';
import { BlockPreview, PageEditor } from './page-editor';

export const metadata: Metadata = { title: 'ویرایش صفحه متنی | پنل داخلی سپهر' };

/** One text page: the editor from the version in force, and every version with its decision. */
export default async function PageVersions({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  const slug = CONTENT_SLUGS.find((s): s is ContentSlug => s === raw);
  if (!slug) notFound();
  const [session, api] = await Promise.all([getSession(), serverApi()]);
  let versions;
  try {
    versions = (await unwrap(api.GET('/api/v1/config/content/pages'))).filter(
      (v) => v.slug === slug,
    );
  } catch (error) {
    return (
      <>
        <PageHeader title={CONTENT_SLUG_TITLES[slug]} />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const inForce = versions.find((v) => v.status === 'approved');
  const start = inForce ?? versions[0];
  const me = session?.me.accountId;
  const legal = slug === 'terms' || slug === 'privacy';
  return (
    <>
      <PageHeader
        title={`صفحه «${CONTENT_SLUG_TITLES[slug]}»`}
        description={
          inForce
            ? `نسخه ${faDigits(inForce.version)} منتشر است.`
            : 'هنوز نسخه‌ای منتشر نشده؛ صفحه عمومی ۴۰۴ است.'
        }
        actions={
          <Link href="/content/pages" className="text-accent underline">
            همه صفحه‌ها
          </Link>
        }
      />
      <Notice tone="warning" title="یادداشت">
        {legal
          ? 'متن حقوقی نهایی این صفحه را حقوقدان می‌دهد؛ متن کنونی نمونه است و پیش از راه‌اندازی جایگزین می‌شود.'
          : 'متن حقوقی نهایی (قوانین و حریم خصوصی) را حقوقدان می‌دهد؛ این صفحه را با همان لحن هماهنگ کنید.'}
      </Notice>
      {can(session, 'config.propose_content') ? (
        <PageEditor
          slug={slug}
          title={start?.title ?? CONTENT_SLUG_TITLES[slug]}
          blocks={start?.blocks ?? [{ kind: 'paragraph', text: '' }]}
        />
      ) : (
        <Notice tone="info">
          پیشنهاد تغییر با مدیر سیستم است؛ شما نسخه‌ها را تأیید یا رد می‌کنید.
        </Notice>
      )}
      <section aria-label="نسخه‌ها" className="space-y-3">
        <h2 className="font-bold">نسخه‌ها</h2>
        {versions.map((v) => (
          <details
            key={v.id}
            open={v.status === 'pending'}
            className="rounded-lg border border-border bg-surface p-4"
          >
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <span className="figures">نسخه {faDigits(v.version)}</span>
              <StatusBadge tone={CONTENT_STATUS[v.status].tone}>
                {CONTENT_STATUS[v.status].label}
              </StatusBadge>
              <span className="figures text-[length:var(--text-xs)] text-ink-muted">
                {showInstant(v.createdAt)} · دلیل: {v.reason}
              </span>
            </summary>
            <div className="space-y-2 pt-3">
              <p className="font-bold">{v.title}</p>
              {v.blocks.map((b, i) => (
                <BlockPreview key={i} block={b} />
              ))}
              {v.status === 'pending' && can(session, 'config.approve_content') && (
                <DecideVersion kind="pages" id={v.id} mine={v.proposedBy === me} />
              )}
            </div>
          </details>
        ))}
      </section>
    </>
  );
}
