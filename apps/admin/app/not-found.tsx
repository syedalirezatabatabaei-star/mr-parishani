import { buttonClass } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'صفحه پیدا نشد',
  robots: { index: false, follow: false },
};

/** Our own 404: Next's default carries an inline style the CSP refuses (rules 17–20). */
export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center"
    >
      <p className="figures text-[length:var(--text-2xl)] font-extrabold text-accent">۴۰۴</p>
      <h1 className="text-[length:var(--text-xl)] font-bold">صفحه‌ای که دنبالش بودید پیدا نشد</h1>
      <p className="text-ink-muted">ممکن است نشانی اشتباه باشد یا صفحه جابه‌جا شده باشد.</p>
      <Link href="/" className={buttonClass('primary')}>
        بازگشت به صفحه اصلی
      </Link>
    </main>
  );
}
