import { unwrap } from '@sepehr/api-client';
import { ApiProvider, AuthFrame, THEME_COOKIE } from '@sepehr/ui';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { getCities } from '../../lib/cities';
import { serverApi } from '../../lib/server-api';
import { JoinForm } from './join-form';

export const metadata: Metadata = {
  title: 'درخواست همکاری مراکز درمانی | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/**
 * Owner 1405/08/10: the public request of a center or a doctor to join, its mobile proved by a
 * code and its documents scanned; it goes to the network specialist's queue (two people decide).
 */
export default async function JoinPage() {
  const [cities, fields] = await Promise.all([
    getCities(),
    (async () => unwrap((await serverApi()).GET('/api/v1/catalog/fields')).catch(() => []))(),
  ]);
  return (
    <ApiProvider csrfToken={null}>
      <AuthFrame
        theme={(await cookies()).get(THEME_COOKIE)?.value === 'dark' ? 'dark' : 'light'}
        tone="panel"
        area="همکاری مراکز و پزشکان"
        badge="building"
        wide
        title="درخواست همکاری"
        lead="مرکز درمانی، مطب یا پزشک هستید؟ اطلاعات را بفرستید؛ کارشناس شبکه درمان بررسی می‌کند و نتیجه را پیامک می‌کنیم."
        heading="بیماران بیشتر، پرداخت با اعتبار درمان و اقساط."
        points={[
          {
            glyph: 'clipboard',
            title: '۱. ثبت درخواست',
            text: 'اطلاعات مرکز، مسئول، پزشکان و مدارک؛ موبایل مسئول با کد پیامکی تأیید می‌شود.',
          },
          {
            glyph: 'userCheck',
            title: '۲. بررسی کارشناس شبکه درمان',
            text: 'مدارک بررسی می‌شود؛ نتیجه، تأیید یا رد با دلیل، پیامک می‌شود.',
          },
          {
            glyph: 'users',
            title: '۳. قرارداد و فعال‌سازی دونفره',
            text: 'فعال‌سازی مرکز با تأیید مدیر شبکه درمان؛ هیچ مرکزی خودکار فعال نمی‌شود.',
          },
          {
            glyph: 'key',
            title: '۴. ورود به پنل',
            text: 'پیوندی یک‌بارمصرف برای ساخت رمز و ورود دومرحله‌ای پیامک می‌شود.',
          },
        ]}
        footer={
          <p>
            حساب پنل دارید؟{' '}
            <Link
              href="/panel/login"
              className="font-bold text-accent underline underline-offset-4"
            >
              ورود به پنل مرکز
            </Link>
          </p>
        }
      >
        <JoinForm
          cities={cities.filter((c) => c.active).map((c) => ({ value: c.code, label: c.name }))}
          fields={fields.map((f) => ({ value: f.code, label: f.name }))}
        />
      </AuthFrame>
    </ApiProvider>
  );
}
