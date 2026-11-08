import { ApiError, unwrap } from '@sepehr/api-client';
import type { PublicProfile } from '@sepehr/contracts';
import { buttonClass, faDigits, showInstantDay, toman } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { cityNamer } from '../../../../lib/cities';
import { publicOrigin } from '../../../../lib/origin';
import { serverApi } from '../../../../lib/server-api';
import { profileStructuredData, serializeStructuredData } from '../../../../lib/structured-data';

/**
 * The public page of a doctor (doc 08 §10, ADR-014, ADR-029): rendered on the server with
 * full metadata (title, description, canonical, Open Graph) and structured data
 * (`Physician`, `MedicalClinic`), so the WordPress site can link here and SEO needs no
 * rewrite later. Only the published version is shown; an unpublished or unknown profile is
 * not found and never indexed; an old address redirects permanently to the current one.
 */

type Params = Promise<{ slug: string }>;

/** One read per request, shared by the metadata and the page. */
const loadProfile = cache(async (slug: string): Promise<PublicProfile> => {
  const api = await serverApi();
  try {
    return await unwrap(
      api.GET('/api/v1/public/doctors/{slug}', {
        params: { path: { slug: slug.toLowerCase() } },
        redirect: 'manual',
      }),
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === 'moved' && error.location) {
      // The API answers with its own path; the page lives at /doctors/<slug>.
      const current = error.location.split('/').pop() ?? '';
      permanentRedirect(`/doctors/${encodeURIComponent(current)}`);
    }
    if (error instanceof ApiError && error.notFound) notFound();
    throw error;
  }
});

const describe = (p: PublicProfile, cityName: (code: string) => string) =>
  [
    p.specialtyTitle ?? p.treatmentFields.map((f) => f.name).join('، '),
    p.workplaces[0]?.placeName,
    p.workplaces[0] ? cityName(p.workplaces[0].cityCode) : null,
    'نوبت‌دهی اینترنتی در سپهر سلامتی',
  ]
    .filter(Boolean)
    .join('، ');

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const profile = await loadProfile((await params).slug);
  const cityName = await cityNamer();
  const url = `${publicOrigin()}/doctors/${profile.slug}`;
  const image = profile.photo?.variants.at(-1)?.url;
  return {
    title: `${profile.doctor.name}${profile.specialtyTitle ? `، ${profile.specialtyTitle}` : ''} | سپهر سلامتی`,
    description: describe(profile, cityName),
    alternates: { canonical: url },
    openGraph: {
      type: 'profile',
      locale: 'fa_IR',
      url,
      title: profile.doctor.name,
      description: describe(profile, cityName),
      siteName: 'سپهر سلامتی',
      ...(image ? { images: [{ url: image }] } : {}),
    },
    // Task 8-3: only an indexable profile (a listed workplace) is offered to search engines.
    robots: profile.indexable ? { index: true, follow: true } : { index: false, follow: true },
  };
}

const SOCIAL_LABELS: Readonly<Record<PublicProfile['socials'][number]['kind'], string>> = {
  instagram: 'اینستاگرام',
  telegram: 'تلگرام',
  linkedin: 'لینکدین',
  aparat: 'آپارات',
  eitaa: 'ایتا',
  bale: 'بله',
  rubika: 'روبیکا',
  website: 'وب‌سایت',
};

const priceText = (s: PublicProfile['workplaces'][number]['services'][number]) =>
  s.isFree
    ? 'رایگان'
    : s.minRial === s.maxRial
      ? toman(s.minRial)
      : `${toman(s.minRial)} تا ${toman(s.maxRial)}`;

export default async function DoctorPage({ params }: { params: Params }) {
  const profile = await loadProfile((await params).slug);
  const cityName = await cityNamer();
  const url = `${publicOrigin()}/doctors/${profile.slug}`;
  const photo = profile.photo?.variants ?? [];
  return (
    <article className="space-y-8">
      <script
        type="application/ld+json"
        // Data, not code: the CSP does not run it; text is escaped above.
        dangerouslySetInnerHTML={{
          __html: serializeStructuredData(
            profileStructuredData(profile, url, describe(profile, cityName), cityName),
          ),
        }}
      />
      <header className="flex flex-wrap items-center gap-5">
        {photo.length > 0 && (
          // Public storage, already resized by the media worker (ADR-029).
          // eslint-disable-next-line @next/next/no-img-element -- variants are made upstream
          <img
            src={photo[0]?.url}
            srcSet={photo
              .filter((v) => v.width)
              .map((v) => `${v.url} ${String(v.width)}w`)
              .join(', ')}
            sizes="128px"
            alt={`عکس ${profile.doctor.name}`}
            width={128}
            height={128}
            className="size-32 rounded-full object-cover"
          />
        )}
        <div className="space-y-1">
          <h1 className="text-[length:var(--text-2xl)] font-extrabold">{profile.doctor.name}</h1>
          {profile.specialtyTitle && <p className="text-ink-muted">{profile.specialtyTitle}</p>}
          <p className="text-[length:var(--text-sm)] text-ink-muted">
            شماره نظام پزشکی:{' '}
            <span className="figures">{faDigits(profile.medicalCouncilNumber)}</span>
          </p>
          {profile.withSepehrSince && (
            <p className="text-[length:var(--text-sm)] text-ink-muted">
              همکار سپهر سلامتی از {showInstantDay(profile.withSepehrSince)}
            </p>
          )}
        </div>
      </header>

      {profile.biography && (
        <section className="space-y-2">
          <h2 className="text-[length:var(--text-lg)] font-bold">درباره پزشک</h2>
          <p className="max-w-prose leading-loose whitespace-pre-line">{profile.biography}</p>
        </section>
      )}

      {profile.history.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[length:var(--text-lg)] font-bold">سوابق</h2>
          <ul className="list-inside list-disc space-y-1">
            {profile.history.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}

      {profile.video?.hosting === 'aparat' && (
        <section className="space-y-2">
          <h2 className="text-[length:var(--text-lg)] font-bold">ویدئو</h2>
          <div className="aspect-video max-w-2xl overflow-hidden rounded-lg bg-sunken">
            <iframe
              src={`https://www.aparat.com/video/video/embed/videohash/${encodeURIComponent(profile.video.aparatId)}/vt/frame`}
              title={`ویدئوی معرفی ${profile.doctor.name}`}
              className="size-full"
              allowFullScreen
              loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-presentation"
            />
          </div>
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-[length:var(--text-lg)] font-bold">محل‌های کار و نوبت</h2>
        {profile.workplaces.length === 0 ? (
          <p className="text-ink-muted">این پزشک فعلاً نوبت اینترنتی نمی‌دهد.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {profile.workplaces.map((w) => (
              <div
                key={w.workplaceId}
                className="space-y-3 rounded-lg border border-border bg-surface p-4"
              >
                <div className="space-y-1">
                  <h3 className="font-bold">{w.placeName ?? 'مطب'}</h3>
                  <p className="text-[length:var(--text-sm)] text-ink-muted">
                    {[
                      // The default branch is named after the center: once is enough.
                      w.branchName === w.placeName ? null : w.branchName,
                      w.address,
                      cityName(w.cityCode),
                    ]
                      .filter(Boolean)
                      .join('، ')}
                  </p>
                </div>
                {w.services.length > 0 && (
                  <dl className="space-y-1 text-[length:var(--text-sm)]">
                    {w.services.map((s) => (
                      <div key={s.serviceCode} className="flex justify-between gap-3">
                        <dt>{s.serviceName}</dt>
                        <dd className="figures">{priceText(s)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <Link href={`/book/${w.workplaceId}`} className={buttonClass('primary')}>
                  انتخاب زمان و نوبت
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>

      {profile.socials.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[length:var(--text-lg)] font-bold">پیوندها</h2>
          <ul className="flex flex-wrap gap-2">
            {profile.socials.map((s) => (
              <li key={s.url}>
                <a href={s.url} rel="nofollow noopener noreferrer" className={buttonClass('quiet')}>
                  {SOCIAL_LABELS[s.kind]}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
