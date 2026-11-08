import { unwrap } from '@sepehr/api-client';
import {
  ApiProvider,
  AppShell,
  ContentPageLinks,
  LogoutButton,
  MenuSearchButton,
  roleTitle,
  THEME_COOKIE,
} from '@sepehr/ui';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSession, serverApi } from '../../lib/server-api';
import { AdminBell, AdminBottomBar, AdminMenu, AdminSearch } from './admin-nav';
import { RequiredMobile } from './required-mobile';
import { deskItems, sectionsFor, shortcutsOf } from './nav';

/** The mobile's last digits for the menu; none when the API has none to give. */
async function mobileLine(): Promise<string | undefined> {
  try {
    const mobile = await unwrap((await serverApi()).GET('/api/v1/auth/mobile'));
    return mobile.mobileLastFour ? `موبایل …${mobile.mobileLastFour}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The internal panel: the calm panel language (ADR-031); sections by permission, in the ☰
 * menu and, on a phone, the bar of shortcuts (owner 1405/08/10).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  // Owner, question 3 of task 9-3: a mobile proved before anything else in the panel.
  const mobileRequired = session.me.mobileRequired;
  const items = mobileRequired ? [] : deskItems(sectionsFor(session.access.permissions));
  const [jar, subtitle] = await Promise.all([cookies(), mobileLine()]);
  const theme = jar.get(THEME_COOKIE)?.value === 'dark' ? 'dark' : 'light';
  const title = roleTitle(session.access.roles, 'کارمند سپهر');
  return (
    <ApiProvider csrfToken={session.me.csrfToken}>
      <AppShell
        tone="panel"
        theme={theme}
        link={Link}
        brand={<Link href="/">سپهر سلامتی — پنل داخلی</Link>}
        shortBrand={<Link href="/">سپهر سلامتی</Link>}
        menu={
          <AdminMenu
            items={items}
            user={{ title, ...(subtitle ? { subtitle } : {}) }}
            theme={theme}
            version={process.env['SEPEHR_VERSION'] ?? 'توسعه'}
            about={
              <>
                <p>پنل داخلی سامانه اعتبار درمان. وام‌دهنده و طرف قراردادها شرکت آرامش ثروت است.</p>
                <ContentPageLinks origin={process.env['PATIENT_WEB_ORIGIN'] ?? ''} />
              </>
            }
            logout={<LogoutButton to="/login" />}
          />
        }
        search={mobileRequired ? undefined : <AdminSearch items={items} />}
        mobileSearch={mobileRequired ? undefined : <MenuSearchButton />}
        bell={mobileRequired ? undefined : <AdminBell />}
        profile={{ href: '/account', label: title }}
        bottomBar={mobileRequired ? undefined : <AdminBottomBar items={shortcutsOf(items)} />}
      >
        {mobileRequired ? <RequiredMobile /> : children}
      </AppShell>
    </ApiProvider>
  );
}
