import { AuthFrame, THEME_COOKIE, safeNext, StaffLogin } from '@sepehr/ui';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSession } from '../../../lib/server-api';

export const metadata: Metadata = { title: 'ورود | پنل داخلی سپهر' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams)['next'], '/');
  if (await getSession()) redirect(next);
  return (
    <AuthFrame
      theme={(await cookies()).get(THEME_COOKIE)?.value === 'dark' ? 'dark' : 'light'}
      tone="panel"
      area="پنل داخلی"
      title="ورود به پنل داخلی"
      lead="با نام کاربری و رمز عبور سازمانی خود وارد شوید."
      heading="هر کار در جای خودش، هر تغییر با دو امضا."
      points={[
        {
          glyph: 'lock',
          title: 'دسترسی به‌اندازه نقش',
          text: 'هر کارمند فقط بخش‌هایی را می‌بیند که نقشش اجازه می‌دهد.',
        },
        {
          glyph: 'users',
          title: 'تأیید دونفره',
          text: 'تغییرهای حساس و مالی با تأیید نفر دوم اجرا می‌شوند.',
        },
        {
          glyph: 'shield',
          title: 'ورود دومرحله‌ای',
          text: 'پس از رمز، کد برنامه احراز هویت گوشی شما خواسته می‌شود.',
        },
      ]}
      footer={
        <>
          <p>رمز خود را فراموش کرده‌اید؟ با مدیر سیستم تماس بگیرید.</p>
          <p>این پنل فقط از شبکه سازمان در دسترس است.</p>
        </>
      }
    >
      <StaffLogin next={next} />
    </AuthFrame>
  );
}
