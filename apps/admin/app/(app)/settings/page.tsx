import { unwrap } from '@sepehr/api-client';
import type { ConfigVersionViewBody } from '@sepehr/contracts';
import {
  DataTable,
  errorMessage,
  FilterBar,
  Notice,
  one,
  PageHeader,
  SelectField,
  showInstant,
  StatusBadge,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { SETTING_KEYS as KEYS, type SettingKey } from '../../../lib/settings-keys';
import { ProposalDecision, ProposeValue } from '../credit/rules/rule-forms';
import { ProposeFlag } from './settings-forms';
import { inForce } from '../../../lib/in-force';

export const metadata: Metadata = { title: 'تنظیمات هویت، سرنخ، نوبت و پیامک | پنل داخلی سپهر' };

const STATE: Readonly<
  Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }>
> = {
  approved: { label: 'تأییدشده', tone: 'success' },
  proposed: { label: 'پیشنهاد، در انتظار نفر دوم', tone: 'warning' },
  rejected: { label: 'ردشده', tone: 'danger' },
  expired: { label: 'منقضی', tone: 'neutral' },
};

function shown(value: unknown, flag: SettingKey['flag']): string {
  if (flag === 'boolean') return value === true ? 'روشن' : 'خاموش';
  if (flag === 'enabled') {
    return typeof value === 'object' &&
      value !== null &&
      (value as { enabled?: unknown }).enabled === true
      ? 'روشن'
      : 'خاموش';
  }
  return JSON.stringify(value);
}

/**
 * Identity flags and the lead, booking and SMS keys (owner 1405/07/24, م۱۰), through the
 * versioned configuration API only: one key at a time, its versions, a change proposed by
 * one person and approved by another (every key here is sensitive; the API and the database
 * refuse the proposer), each audited by the configuration service.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const chosen = KEYS.find((k) => k.key === one(params, 'key')) ?? KEYS[0];
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  let versions: ConfigVersionViewBody[];
  try {
    versions = await unwrap(
      api.GET('/api/v1/config/keys/{key}/versions', { params: { path: { key: chosen.key } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="تنظیمات" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const current = inForce(versions);
  // Owner 1405/08/03 (0107): a technical key is proposed by one role and decided by another.
  const technical = chosen.manage === 'config.manage_technical';
  const mayPropose =
    can(session, chosen.manage) || (technical && can(session, 'config.propose_technical'));
  const mayDecide =
    can(session, chosen.manage) || (technical && can(session, 'config.approve_technical'));
  const me = session?.me.accountId ?? null;

  return (
    <>
      <PageHeader
        title="تنظیمات هویت، سرنخ، نوبت و پیامک"
        description="هر تغییر را یک نفر پیشنهاد می‌دهد و نفر دیگری تأیید می‌کند؛ هر دو در سابقه ثبت می‌شوند."
      />
      <FilterBar action="/settings" label="انتخاب تنظیم" submitLabel="نمایش">
        <SelectField
          id="key"
          name="key"
          label="تنظیم"
          defaultValue={chosen.key}
          options={KEYS.map((k) => ({ value: k.key, label: `${k.group}: ${k.label}` }))}
        />
      </FilterBar>
      <section
        aria-labelledby="in-force"
        className="space-y-1 rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="in-force" className="font-bold">
          {chosen.label}
        </h2>
        <p className="text-[length:var(--text-sm)] text-ink-muted" dir="ltr">
          {chosen.key}
        </p>
        <p>
          مقدار جاری:{' '}
          {chosen.flag ? (
            <StatusBadge
              tone={shown(current?.value, chosen.flag) === 'روشن' ? 'success' : 'neutral'}
            >
              {shown(current?.value, chosen.flag)}
            </StatusBadge>
          ) : (
            <code dir="ltr" className="break-all">
              {current ? shown(current.value, undefined) : '—'}
            </code>
          )}
        </p>
      </section>
      <DataTable
        caption={`نسخه‌های ${chosen.label}`}
        rows={versions}
        rowKey={(v) => v.id}
        empty={<p>نسخه‌ای نیست.</p>}
        columns={[
          { key: 'created', header: 'ثبت', cell: (v) => showInstant(v.createdAt) },
          {
            key: 'value',
            header: 'مقدار',
            cell: (v) =>
              chosen.flag ? (
                shown(v.value, chosen.flag)
              ) : (
                <code dir="ltr" className="break-all text-[length:var(--text-xs)]">
                  {shown(v.value, undefined)}
                </code>
              ),
          },
          { key: 'reason', header: 'دلیل', cell: (v) => v.reason },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (v) => (
              <StatusBadge tone={STATE[v.status]?.tone ?? 'neutral'}>
                {v.id === current?.id ? 'جاری' : (STATE[v.status]?.label ?? v.status)}
              </StatusBadge>
            ),
          },
          {
            key: 'actions',
            header: 'کار',
            cell: (v) =>
              v.status !== 'proposed' || !mayDecide ? (
                '—'
              ) : v.proposedBy === me ? (
                <StatusBadge tone="info">پیشنهاد خودتان؛ منتظر نفر دوم</StatusBadge>
              ) : (
                <ProposalDecision id={v.id} />
              ),
          },
        ]}
      />
      {mayPropose &&
        (chosen.flag ? (
          <ProposeFlag
            configKey={chosen.key}
            shape={chosen.flag}
            current={current?.value ?? null}
          />
        ) : (
          <ProposeValue
            configKey={chosen.key}
            initial={JSON.stringify(current?.value ?? null, null, 2)}
          />
        ))}
    </>
  );
}
