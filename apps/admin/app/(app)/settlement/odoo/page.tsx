import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  showJalaliMonth,
  tehranToday,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { serverApi } from '../../../../lib/server-api';
import { OdooExportForm, OdooMappingForm } from './odoo-forms';

export const metadata: Metadata = { title: 'خروجی Odoo | پنل داخلی سپهر' };

/**
 * The Odoo 19 export (task 5-7; doc 06 §7; owner 5.5): the mapping of internal accounts to
 * Odoo's, set here; a month's documents as an import file (an ISO date for Odoo, a Jalali one
 * beside it); the exports made, with their totals.
 */
export default async function OdooPage() {
  const api = await serverApi();
  let data;
  try {
    data = await Promise.all([
      unwrap(api.GET('/api/v1/settlement/odoo/mappings')),
      unwrap(api.GET('/api/v1/settlement/odoo/exports')),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="خروجی Odoo" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const [mappings, exports] = data;
  return (
    <>
      <PageHeader
        title="خروجی Odoo"
        description="نگاشت حساب‌ها، و فایل اسناد هر ماه برای Odoo؛ شناسه هر سند در هر بار خروجی یکسان است."
      />
      <DataTable
        caption="نگاشت حساب‌ها"
        rows={mappings}
        rowKey={(m) => m.internalCode}
        empty={<EmptyState title="هنوز نگاشتی ثبت نشده است." />}
        columns={[
          {
            key: 'internal',
            header: 'حساب داخلی',
            cell: (m) => <bdi dir="ltr">{m.internalCode}</bdi>,
          },
          {
            key: 'odoo',
            header: 'حساب Odoo',
            cell: (m) => <bdi dir="ltr">{m.odooAccountCode}</bdi>,
          },
          { key: 'reason', header: 'دلیل', cell: (m) => m.reason },
          { key: 'at', header: 'ثبت', cell: (m) => showInstant(m.setAt) },
        ]}
      />
      <OdooMappingForm />
      <OdooExportForm today={tehranToday()} />
      <DataTable
        caption="خروجی‌های ساخته‌شده"
        rows={exports}
        rowKey={(e) => e.id}
        empty={<EmptyState title="هنوز خروجی‌ای ساخته نشده است." />}
        columns={[
          {
            key: 'month',
            header: 'دوره',
            cell: (e) => showJalaliMonth(e.periodYear, e.periodMonth),
          },
          { key: 'documents', header: 'اسناد', cell: (e) => faDigits(e.documents), numeric: true },
          {
            key: 'debit',
            header: 'جمع بدهکار',
            cell: (e) => toman(e.debitTotalRial),
            numeric: true,
          },
          { key: 'at', header: 'ساخت', cell: (e) => showInstant(e.generatedAt) },
        ]}
      />
    </>
  );
}
