import { unwrap } from '@sepehr/api-client';
import { Notice, PageHeader, tehranToday } from '@sepehr/ui';
import type { Metadata } from 'next';
import { getCities } from '../../../../lib/cities';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { RegisterDoctorForm } from './register-doctor-form';

export const metadata: Metadata = { title: 'ثبت پزشک | پنل داخلی سپهر' };

/**
 * A new doctor, entered by hand from the panel (owner 1405/07/27), at a branch of an active
 * center or a private practice, with the contract term required (ADR-046).
 */
export default async function NewDoctorPage() {
  const [api, session, cities] = await Promise.all([serverApi(), getSession(), getCities()]);
  if (!can(session, 'catalog.manage_doctors')) {
    return (
      <>
        <PageHeader title="ثبت پزشک" />
        <Notice tone="danger">اجازه ثبت پزشک را ندارید.</Notice>
      </>
    );
  }
  const [fields, centers] = await Promise.all([
    unwrap(api.GET('/api/v1/catalog/fields')).catch(() => []),
    unwrap(api.GET('/api/v1/catalog/centers', { params: { query: { status: 'active' } } })).catch(
      () => [],
    ),
  ]);
  // The pilot has few centers: the branches of each, as the caller may see them.
  const details = await Promise.all(
    centers.map((c) =>
      unwrap(api.GET('/api/v1/catalog/centers/{id}', { params: { path: { id: c.id } } })).catch(
        () => null,
      ),
    ),
  );
  const branches = details.flatMap((d) =>
    d ? d.branches.map((b) => ({ value: b.id, label: `${d.name} · ${b.name}` })) : [],
  );
  return (
    <>
      <PageHeader title="ثبت پزشک" description="پزشک تازه در یک محل کار، با مدت قرارداد." />
      <RegisterDoctorForm
        today={tehranToday()}
        cities={cities.map((c) => ({ value: c.code, label: c.name }))}
        fields={fields.map((f) => ({ value: f.code, label: f.name }))}
        branches={branches}
      />
    </>
  );
}
