import { unwrap } from '@sepehr/api-client';
import {
  ApiProvider,
  AppShell,
  buttonClass,
  ContentPageLinks,
  Glyph,
  LogoutButton,
  THEME_COOKIE,
} from '@sepehr/ui';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getSession, serverApi } from '../../lib/server-api';
import { patientItems, patientShortcuts } from './me-nav';
import { PatientBell, PatientBottomBar, PatientMenu } from './patient-nav';
import { PersonMobilesBanner } from './person-mobiles';

/** The mobile's last digits for the menu; none when the API has none to give. */
async function mobileLine(): Promise<string | undefined> {
  try {
    const mobile = await unwrap((await serverApi()).GET('/api/v1/auth/mobile'));
    return mobile.mobileLastFour ? `موبایل …${mobile.mobileLastFour}` : undefined;
  } catch {
    return undefined;
  }
}

/** The top bar's doctor search on a wide screen: the search page's own form. */
function DoctorSearch() {
  return (
    <form action="/search" role="search" aria-label="جست‌وجوی پزشک" className="w-full max-w-md">
      <label htmlFor="top-search" className="sr-only">
        جست‌وجوی پزشک، تخصص یا مرکز
      </label>
      <div className="relative">
        <input
          id="top-search"
          name="q"
          type="search"
          placeholder="جست‌وجوی پزشک، تخصص یا مرکز…"
          className="min-h-10 w-full rounded-full border border-border bg-sunken ps-10 pe-4 text-ink placeholder:text-ink-subtle"
        />
        <Glyph
          name="search"
          className="pointer-events-none absolute start-3.5 top-1/2 size-5 -translate-y-1/2 text-ink-subtle"
        />
      </div>
    </form>
  );
}

/** The club in the menu: what it gives; membership is recorded by the club officer. */
function ClubCard() {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-highlight-soft p-3 text-on-highlight-soft">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-highlight text-on-highlight">
        <Glyph name="crown" className="size-5" />
      </span>
      <div className="text-[length:var(--text-sm)]">
        <p className="font-bold">باشگاه مشتریان سپهر</p>
        <p>اعضای باشگاه از طرح‌های ویژه اعتبار درمان بهره می‌برند.</p>
      </div>
    </div>
  );
}

/**
 * Patient pages and the public doctor pages: the warm, expressive language (ADR-031). A
 * signed-in patient gets the ☰ menu and, on a phone, the bar of shortcuts (owner 1405/08/10).
 */
export default async function PatientLayout({ children }: { children: ReactNode }) {
  const [session, jar] = await Promise.all([getSession(), cookies()]);
  const theme = jar.get(THEME_COOKIE)?.value === 'dark' ? 'dark' : 'light';
  const items = patientItems();
  const subtitle = session ? await mobileLine() : undefined;
  const brand = (
    <Link href={session ? '/me' : '/'} className="text-[length:var(--text-lg)] text-accent">
      سپهر سلامتی
    </Link>
  );
  return (
    <ApiProvider csrfToken={session?.me.csrfToken ?? null}>
      <AppShell
        tone="patient"
        theme={theme}
        link={Link}
        brand={brand}
        {...(session
          ? {
              menu: (
                <PatientMenu
                  items={items}
                  user={{ title: 'بیمار سپهر', ...(subtitle ? { subtitle } : {}) }}
                  extra={<ClubCard />}
                  theme={theme}
                  version={process.env['SEPEHR_VERSION'] ?? 'توسعه'}
                  about={
                    <>
                      <p>
                        سپهر سلامتی: پزشک را پیدا کنید، نوبت بگیرید و هزینه درمان را با اعتبار و
                        اقساط بپردازید.
                      </p>
                      <ContentPageLinks />
                    </>
                  }
                  logout={<LogoutButton to="/" />}
                />
              ),
              search: <DoctorSearch />,
              mobileSearch: (
                <Link
                  href="/search"
                  aria-label="جست‌وجوی پزشک"
                  className="grid size-11 place-items-center rounded-md text-ink hover:bg-sunken"
                >
                  <Glyph name="search" />
                </Link>
              ),
              bell: <PatientBell />,
              profile: { href: '/me/mobile', label: 'حساب من' },
              bottomBar: <PatientBottomBar items={patientShortcuts(items)} />,
            }
          : {
              account: (
                <Link href="/login" className={buttonClass('secondary')}>
                  ورود / ثبت‌نام
                </Link>
              ),
            })}
      >
        {session ? <PersonMobilesBanner /> : null}
        {children}
      </AppShell>
    </ApiProvider>
  );
}
