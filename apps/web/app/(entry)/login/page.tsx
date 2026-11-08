import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { ApiProvider, AuthFrame, THEME_COOKIE, safeNext } from '@sepehr/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '../../../lib/server-api';
import { OtpLogin } from './otp-login';

export const metadata: Metadata = {
  title: 'ورود یا ثبت‌نام | سپهر سلامتی',
  robots: { index: false, follow: false },
};

const FOOTER_LINK = 'font-medium text-accent underline-offset-4 hover:underline';

/**
 * The patient's sign-in or sign-up (owner 1405/08/11): the same frame as the panels' sign-in,
 * in the patient's colors; the flow is the one before (mobile, code, an account made by the
 * first code).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams)['next'], '/me');
  if (await getSession()) redirect(next);
  return (
    <ApiProvider csrfToken={null}>
      <AuthFrame
        theme={(await cookies()).get(THEME_COOKIE)?.value === 'dark' ? 'dark' : 'light'}
        tone="patient"
        area="درمان امروز، پرداخت با اقساط"
        badge="mobile"
        title="ورود / ثبت‌نام"
        lead="با شمارهٔ موبایل وارد شوید؛ اگر حساب ندارید، همین‌جا ساخته می‌شود."
        heading="پزشک را پیدا کنید، نوبت بگیرید، با اعتبار درمان بپردازید."
        points={[
          {
            glyph: 'bolt',
            title: 'درخواست سریع',
            text: 'پیش‌فاکتور پزشک را تأیید کنید و برای آن اعتبار درمان بخواهید.',
          },
          {
            glyph: 'coins',
            title: 'اقساط شفاف',
            text: 'مبلغ و سررسید هر قسط از پیش روشن است؛ بی هزینه پنهان.',
          },
          {
            glyph: 'stethoscope',
            title: 'پزشکان معتبر',
            text: 'پزشکان و مراکز همکار، بررسی‌شده با شبکه درمان سپهر.',
          },
        ]}
        footer={
          <nav aria-label="پیوندهای سپهر سلامتی">
            <ul className="flex flex-wrap gap-x-4 gap-y-2">
              <li>
                <Link href="/pages/about" className={FOOTER_LINK}>
                  درباره سپهر
                </Link>
              </li>
              <li>
                <Link href="/pages/terms" className={FOOTER_LINK}>
                  قوانین
                </Link>
                {' و '}
                <Link href="/pages/privacy" className={FOOTER_LINK}>
                  حریم خصوصی
                </Link>
              </li>
              <li>
                <Link href="/join" className={FOOTER_LINK}>
                  درخواست همکاری مرکز درمان
                </Link>
              </li>
            </ul>
          </nav>
        }
      >
        <OtpLogin next={next} />
      </AuthFrame>
    </ApiProvider>
  );
}
