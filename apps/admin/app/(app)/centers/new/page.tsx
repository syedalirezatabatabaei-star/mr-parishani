import { unwrap } from '@sepehr/api-client';
import { Notice, PageHeader, tehranToday } from '@sepehr/ui';
import type { Metadata } from 'next';
import { getCities } from '../../../../lib/cities';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { RegisterCenterForm } from './register-center-form';

export const metadata: Metadata = { title: 'ثبت مرکز | پنل داخلی سپهر' };

/**
 * A new center, entered by hand from the panel (owner 1405/07/27: the client's data is entered
 * here, not imported), with its contract term required (ADR-046). The API holds the same rules.
 */
export default async function NewCenterPage() {
  const [api, session, cities] = await Promise.all([serverApi(), getSession(), getCities()]);
  if (!can(session, 'catalog.manage_centers')) {
    return (
      <>
        <PageHeader title="ثبت مرکز" />
        <Notice tone="danger">اجازه ثبت مرکز را ندارید.</Notice>
      </>
    );
  }
  const fields = await unwrap(api.GET('/api/v1/catalog/fields')).catch(() => []);
  return (
    <>
      <PageHeader title="ثبت مرکز" description="مرکز تازه پیش‌نویس است تا فعال‌سازی دونفره." />
      <RegisterCenterForm
        today={tehranToday()}
        cities={cities.map((c) => ({ value: c.code, label: c.name }))}
        fields={fields.map((f) => ({ value: f.code, label: f.name }))}
      />
    </>
  );
}
