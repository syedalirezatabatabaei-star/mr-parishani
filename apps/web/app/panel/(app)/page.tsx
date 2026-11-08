import { unwrap } from '@sepehr/api-client';
import { addJalaliDays, toJalali } from '@sepehr/contracts';
import { DeskSummary, EmptyState, faDigits, ServiceDesk, StatTile, bannerSlides } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getWorkplaces } from '../../../lib/panel';
import { apiDay, tehranToday } from '../../../lib/params';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { deskItems, sectionsFor, shortcutsOf } from './nav';

export const metadata: Metadata = {
  title: 'پیشخوان | پنل مرکز',
  robots: { index: false, follow: false },
};

/** Counted as booked: not cancelled, rejected or lapsed (as the dashboard counts). */
const NOT_BOOKED = new Set(['cancelled', 'rejected', 'expired']);
/** The desk reads at most this many workplaces, as the dashboard does. */
const MAX_WORKPLACES = 10;

/**
 * Today's appointments and the requests waiting, over the workplaces one covers, from the
 * lists the dashboard reads; null when they cannot be read.
 */
async function appointmentsInBrief() {
  try {
    const [workplaces, api] = await Promise.all([getWorkplaces(), serverApi()]);
    const today = tehranToday();
    const shown = workplaces.slice(0, MAX_WORKPLACES);
    const [lists, pendings] = await Promise.all([
      Promise.all(
        shown.map((w) =>
          unwrap(
            api.GET('/api/v1/booking/workplaces/{id}/appointments', {
              params: {
                path: { id: w.workplaceId },
                query: { from: apiDay(today), to: apiDay(addJalaliDays(today, 6)) },
              },
            }),
          ),
        ),
      ),
      Promise.all(
        shown.map((w) =>
          unwrap(
            api.GET('/api/v1/booking/workplaces/{id}/pending-approvals', {
              params: { path: { id: w.workplaceId } },
            }),
          ),
        ),
      ),
    ]);
    const booked = lists.flat().filter((a) => !NOT_BOOKED.has(a.status));
    const todays = booked.filter(
      (a) => apiDay(toJalali(new Date(a.startsAt))) === apiDay(today),
    ).length;
    const waiting = pendings.reduce((n, p) => n + p.waitingForManualApproval, 0);
    return { todays, week: booked.length, waiting };
  } catch {
    return null;
  }
}

/** Tickets waiting on the center's answer; none when they cannot be read. */
async function ticketsWaiting(): Promise<number | undefined> {
  try {
    const rows = await unwrap((await serverApi()).GET('/api/v1/panel/tickets'));
    return rows.filter((t) => t.status === 'waiting_on_requester').length;
  } catch {
    return undefined;
  }
}

/** The banners in force for this desk; none when they cannot be read. */
async function deskSlides(audience: 'center' | 'doctor') {
  try {
    const banners = await unwrap(
      (await serverApi()).GET('/api/v1/config/banners', { params: { query: { audience } } }),
    );
    return bannerSlides(banners);
  } catch {
    return [];
  }
}

/** The panel's start page (owner 1405/08/10): the service desk of what the account may use. */
export default async function PanelHome() {
  const session = await getSession();
  const sections = sectionsFor(session?.access.permissions ?? []);
  const [brief, tickets] = await Promise.all([
    can(session, 'booking.read_appointments', 'booking.manage_appointments')
      ? appointmentsInBrief()
      : null,
    can(session, 'ticket.open_center') ? ticketsWaiting() : undefined,
  ]);
  const counts: Record<string, number> = {};
  if (brief?.waiting) counts['/panel/appointments'] = brief.waiting;
  if (tickets) counts['/panel/tickets'] = tickets;
  const items = deskItems(sections, counts);
  // A doctor's own desk, else the center's (owner 1405/08/10).
  const audience =
    session?.access.roles.includes('doctor') && !session.access.roles.includes('center_manager')
      ? ('doctor' as const)
      : ('center' as const);
  const slides = await deskSlides(audience);
  return (
    <ServiceDesk
      title="پیشخوان"
      greeting="بخش‌هایی که به آن‌ها دسترسی دارید."
      items={items.filter((i) => i.href !== '/panel/account')}
      slides={slides}
      summary={
        brief && (
          <DeskSummary title="خلاصه امروز" href="/panel/dashboard" link={Link}>
            <dl className="grid grid-cols-3 gap-3">
              <StatTile label="نوبت‌های امروز" value={faDigits(brief.todays)} />
              <StatTile label="هفت روز آینده" value={faDigits(brief.week)} />
              <StatTile label="منتظر تأیید" value={faDigits(brief.waiting)} />
            </dl>
          </DeskSummary>
        )
      }
      shortcuts={shortcutsOf(items)}
      link={Link}
      empty={
        <EmptyState title="هنوز دسترسی‌ای به شما داده نشده است.">
          از مدیر مرکز بخواهید نقش مناسب را برای شما ثبت کند.
        </EmptyState>
      }
    />
  );
}
