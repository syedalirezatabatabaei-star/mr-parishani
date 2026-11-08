import { unwrap } from '@sepehr/api-client';
import {
  creditPlansSchema,
  scoringRulesetSchema,
  toJalali,
  type ConfigVersionViewBody,
  type CreditPlans,
  type ScoringRuleset,
} from '@sepehr/contracts';
import {
  DataTable,
  errorMessage,
  Notice,
  one,
  PageHeader,
  SelectField,
  FilterBar,
  showInstant,
  StatusBadge,
  type SearchParams,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { planChanges } from '../../../../lib/plan-editor';
import { scoringChanges } from '../../../../lib/scoring-editor';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { PlansEditor } from './plans-editor';
import { ProposalDecision, ProposeValue } from './rule-forms';
import { ScoringEditor } from './scoring-editor';
import { inForce } from '../../../../lib/in-force';

export const metadata: Metadata = { title: 'طرح‌ها و قواعد | پنل داخلی سپهر' };

/** The credit configuration managed here; every change needs a second person (doc 04 §5). */
const KEYS = [
  { key: 'credit.plans', label: 'طرح‌های وام' },
  { key: 'credit.scoring_ruleset', label: 'نسخه قواعد امتیاز' },
  { key: 'credit.rejection_reasons', label: 'دلایل رد' },
  { key: 'credit.committee_units', label: 'واحدهای کمیته' },
  { key: 'credit.small_shortfall_bps', label: 'آستانه کسری کم' },
  // ADR-051: the cap on a borrower's whole active balance ("0" = off), basis and what it counts.
  { key: 'credit.borrower_exposure_cap', label: 'سقف مانده فعال هر وام‌گیرنده' },
  // The loan contract's template (task 4-1): its guard refuses one without the penalty field.
  { key: 'contract.loan_template', label: 'قالب قرارداد وام' },
] as const;

const STATE: Readonly<
  Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }>
> = {
  approved: { label: 'تأییدشده', tone: 'success' },
  proposed: { label: 'پیشنهاد، در انتظار نفر دوم', tone: 'warning' },
  rejected: { label: 'ردشده', tone: 'danger' },
  expired: { label: 'منقضی', tone: 'neutral' },
};

/**
 * A proposed version's changes against the value in force, in Persian, for the approver: the
 * two keys with a form (owner 1405/08/10); the others show their JSON in the versions.
 */
function proposedChanges(key: string, current: unknown, proposed: unknown): string[] | null {
  if (key === 'credit.plans') {
    const [a, b] = [creditPlansSchema.safeParse(current), creditPlansSchema.safeParse(proposed)];
    return a.success && b.success
      ? planChanges(current as CreditPlans, proposed as CreditPlans)
      : null;
  }
  if (key === 'credit.scoring_ruleset') {
    const [a, b] = [
      scoringRulesetSchema.safeParse(current),
      scoringRulesetSchema.safeParse(proposed),
    ];
    return a.success && b.success
      ? scoringChanges(current as ScoringRuleset, proposed as ScoringRuleset)
      : null;
  }
  return null;
}

/**
 * Credit plans and the scoring rules version (doc 10 §3, §5; task 3-8): every version of
 * the value with who proposed and decided it, and a change proposed by one person and
 * approved by another. A rules version that breaks the golden cases is refused by the API
 * (task 3-2), whatever this page sends. The plans and the scoring rules are edited in forms
 * (owner 1405/08/10), from the stored value as it is, so an untouched field goes back the same;
 * the other keys keep the JSON field.
 */
export default async function CreditRulesPage({
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
      api.GET('/api/v1/config/keys/{key}/versions', {
        params: { path: { key: chosen.key } },
      }),
    );
  } catch (error) {
    return (
      <>
        <PageHeader title="طرح‌ها و قواعد" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const current = inForce(versions);
  const mayManage = can(session, 'config.manage_business');
  const me = session?.me.accountId ?? null;
  const today = toJalali(new Date());
  // The form reads the stored value as it is (not the schema's copy, which reorders keys).
  const scoring =
    chosen.key === 'credit.scoring_ruleset' &&
    scoringRulesetSchema.safeParse(current?.value).success
      ? (current?.value as ScoringRuleset)
      : null;
  const plans =
    chosen.key === 'credit.plans' && creditPlansSchema.safeParse(current?.value).success
      ? (current?.value as CreditPlans)
      : null;
  const planContext = plans
    ? await Promise.all([
        unwrap(api.GET('/api/v1/catalog/fields')).catch(() => []),
        unwrap(api.GET('/api/v1/config/cities')).catch(() => []),
        unwrap(
          api.GET('/api/v1/config/keys/{key}/versions', {
            params: { path: { key: 'repayment.rounding_unit_rial' } },
          }),
        ).catch(() => []),
      ])
    : null;

  return (
    <>
      <PageHeader title="طرح‌ها و قواعد" description={chosen.label} />
      <p>
        <Link href="/credit" className="text-accent underline">
          پرونده‌های اعتباری
        </Link>
      </p>
      <FilterBar action="/credit/rules" label="انتخاب پیکربندی" submitLabel="نمایش">
        <SelectField
          id="key"
          name="key"
          label="پیکربندی"
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
          { key: 'created', header: 'ثبت', cell: (v) => showInstant(v.createdAt) },
          {
            key: 'effective',
            header: 'اجرا از',
            cell: (v) => (v.effectiveAt ? showInstant(v.effectiveAt) : 'از تأیید'),
          },
          { key: 'reason', header: 'دلیل', cell: (v) => v.reason },
          {
            key: 'changes',
            header: 'تغییرات',
            cell: (v) => {
              if (v.status !== 'proposed') return '—';
              const lines = proposedChanges(chosen.key, current?.value, v.value);
              if (lines === null) return '—';
              if (lines.length === 0) return 'بی تغییر';
              return (
                <ul className="list-disc ps-5">
                  {lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              );
            },
          },
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
              v.status !== 'proposed' || !mayManage ? (
                '—'
              ) : v.proposedBy === me ? (
                <StatusBadge tone="info">پیشنهاد خودتان؛ منتظر نفر دوم</StatusBadge>
              ) : (
                <ProposalDecision id={v.id} />
              ),
          },
        ]}
      />
      {scoring ? (
        <ScoringEditor current={scoring} mayEdit={mayManage} today={today} />
      ) : plans && planContext ? (
        <PlansEditor
          current={plans}
          fields={planContext[0].map((f) => ({ code: f.code, name: f.name }))}
          cities={planContext[1]
            .filter((c) => c.active)
            .map((c) => ({ code: c.code, name: c.name }))}
          roundingUnitRial={(() => {
            const r = inForce(planContext[2])?.value;
            return typeof r === 'string' && /^[1-9][0-9]*$/.test(r) ? r : '1';
          })()}
          today={today}
          mayEdit={mayManage}
        />
      ) : (
        mayManage && (
          <ProposeValue
            configKey={chosen.key}
            initial={JSON.stringify(current?.value ?? null, null, 2)}
          />
        )
      )}
    </>
  );
}
