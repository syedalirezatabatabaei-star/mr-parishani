import { buttonClass } from '@sepehr/ui';
import Link from 'next/link';

export default function HomePage() {
  return (
    <section className="space-y-4 py-8">
      <h1 className="text-[length:var(--text-2xl)] font-extrabold text-ink">
        پزشک خود را پیدا کنید و نوبت بگیرید
      </h1>
      <p className="max-w-prose text-ink-muted">
        پزشکان و مراکز درمانی همکار سپهر سلامتی را جست‌وجو کنید، زمان آزاد را ببینید و همین‌جا نوبت
        بگیرید.
      </p>
      <Link href="/search" className={buttonClass('primary')}>
        جست‌وجوی پزشک
      </Link>
    </section>
  );
}
