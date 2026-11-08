import { ApiProvider, AuthFrame, THEME_COOKIE } from '@sepehr/ui';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { SetupForm } from './setup-form';

export const metadata: Metadata = {
  title: 'ساخت رمز پنل مرکز | سپهر سلامتی',
  robots: { index: false, follow: false },
  // The page's address never travels on: the token is in the fragment anyway.
  referrer: 'no-referrer',
};

/** A new center user's one-time link (owner 1405/08/10). */
export default async function SetupPage() {
  return (
    <ApiProvider csrfToken={null}>
      <AuthFrame
        theme={(await cookies()).get(THEME_COOKIE)?.value === 'dark' ? 'dark' : 'light'}
        tone="panel"
        area="پنل مراکز و پزشکان"
        badge="key"
        title="ساخت رمز ورود"
        lead="درخواست همکاری شما تأیید شده است. رمز ورود خود را بسازید؛ این پیوند یک بار به کار می‌رود."
        heading="به سپهر سلامتی خوش آمدید."
        points={[
          {
            glyph: 'key',
            title: 'رمز را خودتان می‌سازید',
            text: 'هیچ‌کس جز شما رمز را نمی‌داند؛ پیامک فقط پیوند را داشت.',
          },
          {
            glyph: 'shield',
            title: 'ورود دومرحله‌ای',
            text: 'در اولین ورود، برنامه احراز هویت گوشی را فعال می‌کنید.',
          },
          {
            glyph: 'building',
            title: 'فعال‌سازی مرکز',
            text: 'مرکز پس از تأیید دونفره شبکه درمان فعال می‌شود و بیماران آن را می‌بینند.',
          },
        ]}
      >
        <SetupForm />
      </AuthFrame>
    </ApiProvider>
  );
}
