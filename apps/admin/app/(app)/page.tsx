import { unwrap } from '@sepehr/api-client';
import {
  DeskSummary,
  EmptyState,
  faDigits,
  ServiceDesk,
  StatTile,
  toman,
  bannerSlides,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { can, getSession, serverApi, type Session } from '../../lib/server-api';
import { deskItems, sectionsFor, shortcutsOf } from './nav';

export const metadata: Metadata = { title: 'پیشخوان | پنل داخلی سپهر' };

/** A count from a list the account may read; none when the API refuses or fails. */
async function count(read: () => Promise<readonly unknown[]>): Promise<number | undefined> {
  try {
    return (await read()).length;
  } catch {
    return undefined;
  }
}

/**
 * The counters of the desk, each from a list the panel already reads, only for who may
 * read it (owner 1405/08/10: no API made for a counter).
 */
async function counts(session: Session | null): Promise<Record<string, number>> {
  const api = await serverApi();
  const queue = (queueCode: 'completion' | 'credit' | 'committee') =>
    count(() =>
      unwrap(api.GET('/api/v1/credit/applications/queue', { params: { query: { queueCode } } })),
    );
  const credit = can(session, 'credit.read_applications');
  const [tickets, mine, committee, completion, mobiles] = await Promise.all([
    can(session, 'ticket.work', 'ticket.assign', 'ticket.read_all')
      ? count(() => unwrap(api.GET('/api/v1/tickets/queue', { params: { query: {} } })))
      : undefined,
    credit ? queue('credit') : undefined,
    credit ? queue('committee') : undefined,
    credit ? queue('completion') : undefined,
    can(session, 'lead.approve_person_mobile')
      ? count(() => unwrap(api.GET('/api/v1/lead/person-mobiles/pending')))
      : undefined,
  ]);
  const out: Record<string, number> = {};
  if (tickets) out['/tickets'] = tickets;
  if ((mine ?? 0) + (committee ?? 0) > 0) out['/credit'] = (mine ?? 0) + (committee ?? 0);
  if (completion) out['/completion'] = completion;
  if (mobiles) out['/person-mobiles'] = mobiles;
  return out;
}

/** The CEO's dashboard in brief; none when it cannot be read. */
async function ceoSummary() {
  try {
    const d = await unwrap((await serverApi()).GET('/api/v1/reporting/dashboards/ceo'));
    return (
      <DeskSummary title="خلاصه داشبورد مدیرعامل" href="/dashboard" link={Link}>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="پرونده‌های فعال" value={faDigits(d.activeCases)} />
          <StatTile label="شارژ این ماه" value={toman(d.chargedThisMonthRial)} />
          <StatTile label="مانده بدهی" value={toman(d.outstandingDebtRial)} />
          <StatTile label="شکایات باز" value={faDigits(d.openComplaints)} />
        </dl>
      </DeskSummary>
    );
  } catch {
    return null;
  }
}

/** The banners in force for the internal panel (owner 1405/08/10); none when unread. */
async function deskSlides() {
  try {
    const banners = await unwrap(
      (await serverApi()).GET('/api/v1/config/banners', {
        params: { query: { audience: 'staff' } },
      }),
    );
    return bannerSlides(banners);
  } catch {
    return [];
  }
}

/** The panel's start page (owner 1405/08/10): the service desk of what the account may use. */
export default async function AdminHome() {
  const session = await getSession();
  const sections = sectionsFor(session?.access.permissions ?? []);
  const [counted, summary, slides] = await Promise.all([
    counts(session),
    can(session, 'reporting.dashboard_ceo') ? ceoSummary() : null,
    deskSlides(),
  ]);
  const items = deskItems(sections, counted);
  return (
    <ServiceDesk
      title="پیشخوان"
      greeting="بخش‌هایی که به آن‌ها دسترسی دارید."
      items={items.filter((i) => i.href !== '/account')}
      slides={slides}
      summary={summary}
      shortcuts={shortcutsOf(items)}
      link={Link}
      empty={<EmptyState title="هنوز دسترسی‌ای به شما داده نشده است." />}
    />
  );
}
