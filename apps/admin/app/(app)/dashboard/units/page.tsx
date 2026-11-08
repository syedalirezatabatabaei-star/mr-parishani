import { EmptyState, PageHeader } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession } from '../../../../lib/server-api';
import { UNITS } from './units';

export const metadata: Metadata = { title: 'داشبورد واحدها | پنل داخلی سپهر' };

/** The units whose dashboard one may open: one's own, or all for managers (task 7-5). */
export default async function UnitDashboardsPage() {
  const session = await getSession();
  const all = can(session, 'ticket.assign', 'ticket.read_all');
  const roles = session?.access.roles ?? [];
  const units = Object.entries(UNITS).filter(([code]) => all || roles.includes(code));
  return (
    <>
      <PageHeader title="داشبورد واحدها" description="صف، مهلت‌های در خطر و بار کارشناسان." />
      {units.length === 0 ? (
        <EmptyState title="داشبورد واحدی برای شما نیست." />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {units.map(([code, label]) => (
            <li key={code}>
              <Link
                href={`/dashboard/units/${code}`}
                className="block rounded-lg border border-border bg-surface p-4 font-bold text-ink hover:border-accent"
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
