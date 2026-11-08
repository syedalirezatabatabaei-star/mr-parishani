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
import { getSession, serverApi } from '../../../lib/server-api';
import { PanelBell, PanelBottomBar, PanelMenu, PanelSearch } from './panel-nav';
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
 * The center panel: calm and compact (ADR-031); sections by permission, in the ☰ menu and,
 * on a phone, the bar of shortcuts (owner 1405/08/10).
 */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/panel/login');
  const items = deskItems(sectionsFor(session.access.permissions));
  const [jar, subtitle] = await Promise.all([cookies(), mobileLine()]);
  const theme = jar.get(THEME_COOKIE)?.value === 'dark' ? 'dark' : 'light';
  const title = roleTitle(session.access.roles, 'کاربر مرکز');
  return (
    <ApiProvider csrfToken={session.me.csrfToken}>
      <AppShell
        tone="panel"
        theme={theme}
        link={Link}
        brand={<Link href="/panel">سپهر سلامتی — پنل مرکز</Link>}
        shortBrand={<Link href="/panel">سپهر سلامتی</Link>}
        menu={
          <PanelMenu
            items={items}
            user={{ title, ...(subtitle ? { subtitle } : {}) }}
            theme={theme}
            version={process.env['SEPEHR_VERSION'] ?? 'توسعه'}
            about={
              <>
                <p>پنل مراکز و پزشکان همکار سپهر سلامتی: نوبت، پیش‌فاکتور، خدمت و تسویه.</p>
                <ContentPageLinks />
              </>
            }
            logout={<LogoutButton to="/panel/login" />}
          />
        }
        search={<PanelSearch items={items} />}
        mobileSearch={<MenuSearchButton />}
        bell={<PanelBell />}
        profile={{ href: '/panel/account', label: title }}
        bottomBar={<PanelBottomBar items={shortcutsOf(items)} />}
      >
        {children}
      </AppShell>
    </ApiProvider>
  );
}
