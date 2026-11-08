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
import { shownValue, type LaunchKey } from '../../../lib/launch-keys';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { ProposalDecision } from '../credit/rules/rule-forms';
import { ProposeLaunchValue } from './launch-forms';
import { inForce } from '../../../lib/in-force';

const STATE: Readonly<
  Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }>
> = {
  approved: { label: 'تأییدشده', tone: 'success' },
  proposed: { label: 'پیشنهاد، در انتظار نفر دوم', tone: 'warning' },
  rejected: { label: 'ردشده', tone: 'danger' },
  expired: { label: 'منقضی', tone: 'neutral' },
};

/**
 * A page of typed settings, one key at a time: its versions, a change proposed by one person
 * and approved by another, each audited by the configuration service. The launch settings
 * (plan item الف) and the other business keys (owner 1405/08/10) are both this page.
 */
export async function ConfigKeysPage({
  searchParams,
  keys,
  title,
  path,
  effect,
}: {
  searchParams: Promise<SearchParams>;
  keys: readonly [LaunchKey, ...LaunchKey[]];
  title: string;
  path: string;
  /** What a value changes for cases already under way, said before anyone proposes it. */
  effect: Readonly<Record<string, string>>;
}) {
  const params = await searchParams;
  const chosen = keys.find((k) => k.key === one(params, 'key')) ?? keys[0];
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  let versions: ConfigVersionViewBody[];
  try {
    versions = await unwrap(
      api.GET('/api/v1/config/keys/{key}/versions', { params: { path: { key: chosen.key } } }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title={title} />
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
        title={title}
        description="هر تغییر را یک نفر پیشنهاد می‌دهد و نفر دیگری تأیید می‌کند؛ هر دو در سابقه ثبت می‌شوند."
      />
      <FilterBar action={path} label="انتخاب تنظیم" submitLabel="نمایش">
        <SelectField
          id="key"
          name="key"
          label="تنظیم"
          defaultValue={chosen.key}
          options={keys.map((k) => ({ value: k.key, label: k.label }))}
        />
      </FilterBar>
      <section
        aria-labelledby="in-force"
        className="space-y-2 rounded-lg border border-border bg-surface p-4"
      >
        <h2 id="in-force" className="font-bold">
          {chosen.label}
        </h2>
        <p className="text-[length:var(--text-sm)] text-ink-muted" dir="ltr">
          {chosen.key}
        </p>
        <p>
          مقدار جاری: <strong>{shownValue(chosen.kind, current?.value)}</strong>
        </p>
        <p className="text-[length:var(--text-sm)]">مقدار مصوب: {chosen.agreed}</p>
        {chosen.launchCheckItem && (
          <p className="text-[length:var(--text-sm)] text-ink-muted">
            بررسی پیش از راه‌اندازی، بند {chosen.launchCheckItem.toLocaleString('fa-IR')}
          </p>
        )}
        {effect[chosen.key] && <Notice tone="info">{effect[chosen.key]}</Notice>}
      </section>
      <DataTable
        caption={`نسخه‌های ${chosen.label}`}
        rows={versions}
        rowKey={(v) => v.id}
        empty={<p>نسخه‌ای نیست.</p>}
        columns={[
          { key: 'created', header: 'ثبت', cell: (v) => showInstant(v.createdAt) },
          { key: 'value', header: 'مقدار', cell: (v) => shownValue(chosen.kind, v.value) },
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
      {mayPropose ? (
        <ProposeLaunchValue
          configKey={chosen.key}
          kind={chosen.kind}
          current={current?.value ?? null}
          bounds={chosen.bounds}
        />
      ) : (
        <Notice tone="info">
          این تنظیم را فقط دارنده مجوز{' '}
          {chosen.manage === 'config.manage_technical' ? 'تنظیمات فنی' : 'تنظیمات کسب‌وکار'} پیشنهاد
          می‌دهد.
        </Notice>
      )}
    </>
  );
}
