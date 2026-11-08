import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  faDigits,
  Notice,
  PageHeader,
  rial,
  showInstant,
  StatusBadge,
  tehranToday,
  type StatusTone,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { DecideVisitTariff, ProposeVisitTariff } from './visit-tariff-forms';

export const metadata: Metadata = { title: 'تعرفه ویزیت پزشکان | پنل داخلی سپهر' };

const STATUS: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  pending: { label: 'در انتظار تأیید', tone: 'warning' },
  approved: { label: 'تأیید شد', tone: 'success' },
  rejected: { label: 'رد شد', tone: 'danger' },
};

/**
 * A doctor's visit price from the internal panel, by two people (owner 1405/07/29, answer i):
 * proposed by one, approved by another, which writes the visit's tariff version. The center
 * panel's own path stays until the two-person flag `catalog.visit_tariff_internal_only` is on.
 */
export default async function VisitTariffsPage() {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  if (!can(session, 'catalog.manage_visit_tariffs')) {
    return (
      <>
        <PageHeader title="تعرفه ویزیت پزشکان" />
        <Notice tone="danger">اجازه این بخش را ندارید.</Notice>
      </>
    );
  }
  const [workplaces, proposals] = await Promise.all([
    unwrap(api.GET('/api/v1/catalog/workplaces')).catch(() => []),
    unwrap(api.GET('/api/v1/catalog/visit-tariff-proposals')).catch(() => []),
  ]);
  const options = workplaces.map((w) => ({
    value: w.workplaceId,
    label: [w.doctor.name, w.placeName ?? 'مطب شخصی', w.branchName].filter(Boolean).join(' · '),
  }));
  const pending = proposals.filter((p) => p.status === 'pending');
  const decided = proposals.filter((p) => p.status !== 'pending').slice(0, 20);
  const price = (p: (typeof proposals)[number]) =>
    p.isFree
      ? 'رایگان'
      : p.minAmountRial === p.maxAmountRial
        ? rial(p.minAmountRial)
        : `${rial(p.minAmountRial)} تا ${rial(p.maxAmountRial)}`;
  const who = (p: (typeof proposals)[number]) => `${p.doctor.name} · ${p.placeName ?? 'مطب شخصی'}`;
  return (
    <>
      <PageHeader
        title="تعرفه ویزیت پزشکان"
        description="هر تعرفه را یک نفر پیشنهاد و نفر دیگری تأیید می‌کند؛ تأیید، نسخه تازه تعرفه ویزیت آن محل کار را می‌سازد."
      />
      <ProposeVisitTariff workplaces={options} today={tehranToday()} />
      <DataTable
        caption={`در انتظار تأیید (${faDigits(pending.length)})`}
        rows={pending}
        rowKey={(p) => p.id}
        empty={<p>پیشنهادی در انتظار نیست.</p>}
        columns={[
          { key: 'who', header: 'پزشک و محل کار', cell: who },
          { key: 'price', header: 'قیمت', cell: price, numeric: true },
          {
            key: 'from',
            header: 'اجرا از',
            cell: (p) => (p.effectiveAt ? showInstant(p.effectiveAt) : 'لحظه تأیید'),
          },
          { key: 'reason', header: 'دلیل', cell: (p) => p.reason },
          { key: 'asked', header: 'پیشنهاد', cell: (p) => showInstant(p.requestedAt) },
          {
            key: 'decide',
            header: 'تصمیم',
            cell: (p) => <DecideVisitTariff id={p.id} mine={p.requestedByMe} />,
          },
        ]}
      />
      <DataTable
        caption="تصمیم‌های اخیر"
        rows={decided}
        rowKey={(p) => p.id}
        empty={<p>هنوز تصمیمی گرفته نشده است.</p>}
        columns={[
          { key: 'who', header: 'پزشک و محل کار', cell: who },
          { key: 'price', header: 'قیمت', cell: price, numeric: true },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (p) => (
              <StatusBadge tone={STATUS[p.status]?.tone ?? 'neutral'}>
                {STATUS[p.status]?.label ?? p.status}
              </StatusBadge>
            ),
          },
          { key: 'why', header: 'دلیل تصمیم', cell: (p) => p.decisionReason ?? '—' },
          {
            key: 'when',
            header: 'زمان تصمیم',
            cell: (p) => (p.decidedAt ? showInstant(p.decidedAt) : '—'),
          },
        ]}
      />
    </>
  );
}
