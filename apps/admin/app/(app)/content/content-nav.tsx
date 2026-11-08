import { navLinkClass } from '@sepehr/ui';
import Link from 'next/link';

const TABS = [
  { href: '/content/banners', label: 'بنرهای پیشخوان' },
  { href: '/content/pages', label: 'صفحه‌های متنی' },
  { href: '/content/announcements', label: 'اطلاعیه‌ها' },
] as const;

/** The three parts of «مدیریت محتوای پیشخوان». */
export function ContentNav({ current }: { current: (typeof TABS)[number]['href'] }) {
  return (
    <nav aria-label="بخش‌های محتوای پیشخوان">
      <ul className="flex flex-wrap gap-1 text-[length:var(--text-sm)]">
        {TABS.map((t) => (
          <li key={t.href}>
            <Link
              href={t.href}
              aria-current={t.href === current ? 'page' : undefined}
              className={navLinkClass(t.href === current)}
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
