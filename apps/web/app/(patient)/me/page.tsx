import { unwrap } from '@sepehr/api-client';
import { bannerSlides, ServiceDesk } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../lib/server-api';
import { patientItems, patientShortcuts } from '../me-nav';

export const metadata: Metadata = {
  title: 'پیشخوان | سپهر سلامتی',
  robots: { index: false, follow: false },
};

/** A count from a list the patient reads; none when the API refuses or fails. */
async function count(read: () => Promise<number>): Promise<number | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * The patient's start page after sign-in (owner 1405/08/10): the service desk. The counters
 * come from the lists the patient's pages already read: upcoming appointments, proformas
 * waiting for an answer, tickets waiting on the patient.
 */
export default async function PatientHome() {
  const api = await serverApi();
  const [appointments, proformas, tickets, banners] = await Promise.all([
    count(async () => {
      const page = await unwrap(
        api.GET('/api/v1/booking/me/appointments', {
          params: { query: { when: 'upcoming', page: '1', pageSize: '1' } },
        }),
      );
      return page.total;
    }),
    count(
      async () =>
        (await unwrap(api.GET('/api/v1/me/proformas'))).filter((p) => p.status === 'issued').length,
    ),
    count(
      async () =>
        (await unwrap(api.GET('/api/v1/me/tickets'))).filter(
          (t) => t.status === 'waiting_on_requester',
        ).length,
    ),
    // The banners in force for patients (owner 1405/08/10).
    unwrap(api.GET('/api/v1/config/banners', { params: { query: { audience: 'patient' } } })).catch(
      () => [],
    ),
  ]);
  const counts: Record<string, number> = {};
  if (appointments) counts['/me/appointments'] = appointments;
  if (proformas) counts['/me/proformas'] = proformas;
  if (tickets) counts['/me/tickets'] = tickets;
  const items = patientItems(counts);
  return (
    <ServiceDesk
      title="پیشخوان"
      greeting="به سپهر سلامتی خوش آمدید."
      items={items}
      slides={bannerSlides(banners)}
      shortcuts={patientShortcuts(items)}
      link={Link}
    />
  );
}
