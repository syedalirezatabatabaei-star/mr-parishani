import { unwrap } from '@sepehr/api-client';
import { providerContractEndsOn, toJalali, type ConfigVersionViewBody } from '@sepehr/contracts';
import {
  DataTable,
  errorMessage,
  faDigits,
  FilterBar,
  Notice,
  PageHeader,
  rial,
  SelectField,
  showDay,
  showInstant,
  StatusBadge,
  type StatusTone,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { ProposalDecision } from '../credit/rules/rule-forms';
import { ProposeSettlementRate, type SettlementKey } from './rate-form';

export const metadata: Metadata = { title: 'نرخ‌های تسویه پزشک | پنل داخلی سپهر' };

const CREDIT_FEE = { key: 'settlement.credit_service_fee', label: 'کارمزد خدمت اعتباری' } as const;
const KEYS: readonly { key: SettlementKey; label: string }[] = [
  CREDIT_FEE,
  { key: 'settlement.cash_service_fee', label: 'کارمزد خدمت نقدی' },
  { key: 'settlement.contract_cycle_months', label: 'دوره تسویه (ماه)' },
  // ADR-046 (owner 1405/07/27): from its end, no new service; a notice before it.
  { key: 'settlement.provider_contract', label: 'مدت قرارداد پزشک یا مرکز' },
  { key: 'settlement.provider_contract_warn_days', label: 'هشدار پیش از پایان قرارداد (روز)' },
];
const LEVEL: Readonly<Record<string, string>> = {
  global: 'سراسری',
  treatment_field: 'فیلد درمان',
  center: 'مرکز',
  doctor: 'پزشک',
  city: 'شهر',
};
const STATE: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  proposed: { label: 'در انتظار تأیید', tone: 'warning' },
  approved: { label: 'تأییدشده', tone: 'success' },
  rejected: { label: 'ردشده', tone: 'danger' },
  expired: { label: 'منقضی', tone: 'neutral' },
};

function shown(value: unknown, days = false): string {
  if (value === null) return 'برداشته شد (سطح بالاتر)';
  if (typeof value === 'number') return `${faDigits(value)} ${days ? 'روز' : 'ماه'}`;
  const term = value as { startsOn?: string | null; months?: number | null };
  if ('startsOn' in term) {
    if (!term.startsOn || !term.months) return 'بی مدت';
    const ends = providerContractEndsOn({
      startsOn: term.startsOn,
      months: term.months as 3 | 6 | 12,
    });
    return `${faDigits(term.months)} ماه از ${showDay(term.startsOn)}؛ پایان ${ends ? showDay(ends) : '—'}`;
  }
  const v = value as { basis?: string; bps?: number; rial?: string };
  if (v.basis === 'percent') return `${faDigits(((v.bps ?? 0) / 100).toString())}٪`;
  if (v.basis === 'fixed') return `${rial(v.rial ?? '0')} برای هر خدمت`;
  return JSON.stringify(value);
}

/**
 * A doctor's settlement rates (task 5-1; doc 06 §3; CLAUDE.md §4): the credit and cash
 * service fees (a percent or a fixed amount) and the settlement cycle, at each level, with
 * their versions. A value is proposed by one person and approved by another; it counts only
 * for services final after it, each locking the value in force then. 0 until set.
 */
export default async function SettlementRatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const asked = typeof params['key'] === 'string' ? params['key'] : undefined;
  const chosen = KEYS.find((k) => k.key === asked) ?? CREDIT_FEE;
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  let versions: ConfigVersionViewBody[];
  try {
    versions = await unwrap(
      api.GET('/api/v1/config/keys/{key}/versions', { params: { path: { key: chosen.key } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="نرخ‌های تسویه پزشک" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const mayManage = can(session, 'config.manage_business');
  return (
    <>
      <PageHeader
        title="نرخ‌های تسویه پزشک"
        description="هر تغییر با تأیید نفر دوم؛ فقط برای خدمت‌هایی که پس از آن قطعی شوند."
      />
      <FilterBar action="/settlement-rates" label="انتخاب نرخ" submitLabel="نمایش">
        <SelectField
          id="key"
          name="key"
          label="نرخ"
          defaultValue={chosen.key}
          options={KEYS.map((k) => ({ value: k.key, label: k.label }))}
        />
      </FilterBar>
      <DataTable
        caption={`نسخه‌های ${chosen.label}`}
        rows={versions}
        rowKey={(v) => v.id}
        empty={<p>نسخه‌ای نیست.</p>}
        columns={[
          { key: 'level', header: 'سطح', cell: (v) => LEVEL[v.scopeLevel] ?? v.scopeLevel },
          {
            key: 'ref',
            header: 'مرجع',
            cell: (v) => (v.scopeRef ? <bdi dir="ltr">{v.scopeRef}</bdi> : '—'),
          },
          {
            key: 'value',
            header: 'مقدار',
            cell: (v) => shown(v.value, chosen.key === 'settlement.provider_contract_warn_days'),
          },
          {
            key: 'effective',
            header: 'اجرا از',
            cell: (v) => (v.effectiveAt ? showInstant(v.effectiveAt) : 'از تأیید'),
          },
          { key: 'reason', header: 'دلیل', cell: (v) => v.reason },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (v) => (
              <StatusBadge tone={STATE[v.status]?.tone ?? 'neutral'}>
                {STATE[v.status]?.label ?? v.status}
              </StatusBadge>
            ),
          },
          {
            key: 'actions',
            header: 'تصمیم',
            cell: (v) =>
              v.status === 'proposed' && mayManage ? <ProposalDecision id={v.id} /> : '—',
          },
        ]}
      />
      {mayManage && <ProposeSettlementRate configKey={chosen.key} today={toJalali(new Date())} />}
    </>
  );
}
