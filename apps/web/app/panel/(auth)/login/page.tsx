import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { AuthFrame, THEME_COOKIE, safeNext, StaffLogin } from '@sepehr/ui';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-api';

export const metadata: Metadata = {
  title: 'ورود به پنل مرکز | سپهر سلامتی',
  robots: { index: false, follow: false },
};

export default async function PanelLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams)['next'], '/panel');
  if (await getSession()) redirect(next);
  return (
    <AuthFrame
      theme={(await cookies()).get(THEME_COOKIE)?.value === 'dark' ? 'dark' : 'light'}
      tone="panel"
      area="پنل مراکز و پزشکان"
      title="ورود به پنل مرکز"
      lead="مدیر مرکز، پزشک یا منشی: با نام کاربری و رمز عبور خود وارد شوید."
      heading="نوبت، پیش‌فاکتور، خدمت و تسویه، در یک پنل."
      points={[
        {
          glyph: 'calendar',
          title: 'نوبت و تقویم کاری',
          text: 'ساعت‌های کاری، استثناها و نوبت‌های امروز و آینده.',
        },
        {
          glyph: 'proforma',
          title: 'پیش‌فاکتور و خدمت اعتباری',
          text: 'صدور پیش‌فاکتور و ثبت خدمت برای بیمار شارژشده.',
        },
        {
          glyph: 'bank',
          title: 'تسویه شفاف',
          text: 'صورت‌وضعیت ماهانه، دریافتی‌های آینده و ثبت اعتراض.',
        },
      ]}
      footer={
        <>
          <p>رمز خود را فراموش کرده‌اید؟ با پشتیبانی سپهر سلامتی تماس بگیرید.</p>
          <p>
            مرکز درمانی یا پزشک هستید و هنوز همکار ما نیستید؟{' '}
            <Link href="/join" className="font-bold text-accent underline underline-offset-4">
              درخواست همکاری
            </Link>
          </p>
        </>
      }
    >
      <StaffLogin next={next} />
    </AuthFrame>
  );
}
