import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
  tehranToday,
  toman,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  AUTHORITY_LABEL,
  CREDIT_STATUS,
  DECISION_STATE,
  OUTCOME_LABEL,
  QUEUE_LABEL,
} from '../../../../lib/credit';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { CostSplitSection } from './cost-split-section';
import { PenaltySection } from './penalty-section';
import {
  DecideDocument,
  DecisionActions,
  PostButton,
  ProposeDecision,
  ScoreForm,
  ViewDocument,
} from './credit-actions';

export const metadata: Metadata = { title: 'پرونده اعتباری | پنل داخلی سپهر' };

const DOC_STATE: Readonly<Record<string, string>> = {
  submitted: 'در انتظار بررسی',
  accepted: 'پذیرفته',
  rejected: 'ردشده',
};

/** Where each raw number comes from (doc 10 §5: «مدرک کنار هر عدد»). */
const EVIDENCE: Readonly<Record<string, string>> = {
  job: 'job_proof',
  employmentStartedOn: 'job_proof',
  obligationsRial: 'bank_statement',
  averageBalanceRial: 'bank_statement',
};

const RAW_LABEL: Readonly<Record<string, string>> = {
  job: 'شغل',
  employmentStartedOn: 'شروع اشتغال',
  coverage: 'پوشش حقوق',
  obligationsRial: 'قسط تعهدات قبلی',
  newInstallmentRial: 'قسط تازه',
  averageBalanceRial: 'میانگین مانده',
  installmentRial: 'قسط مورد ضمانت',
  debts: 'بدهی و ضمانت قبلی',
  independence: 'استقلال مالی',
};

function rawValue(key: string, value: unknown): string {
  if (key.endsWith('Rial') && typeof value === 'string') return toman(value);
  if (value && typeof value === 'object' && 'year' in value) {
    const d = value as { year: number; month: number; day: number };
    return `${faDigits(d.year)}/${faDigits(d.month)}/${faDigits(d.day)}`;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-labelledby={id}
    >
      <h2 id={id} className="text-[length:var(--text-lg)] font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * One credit application for the credit units (doc 10 §4–§6; task 3-8): its documents
 * (case completion), the raw data and the engine's output with each criterion (credit
 * specialist), and the decision: who decides, proposals, the second check, the committee.
 * Scores and reasons reach only those who may see them; the API strips them otherwise.
 */
export default async function CreditApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const path = { params: { path: { id } } };
  let app;
  try {
    app = await unwrap(api.GET('/api/v1/credit/applications/{id}', path));
  } catch (error) {
    return (
      <>
        <PageHeader title="پرونده اعتباری" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  const [documents, scoring, decision, assignments] = await Promise.allSettled([
    unwrap(api.GET('/api/v1/credit/applications/{id}/documents', path)),
    unwrap(api.GET('/api/v1/credit/applications/{id}/scoring', path)),
    unwrap(api.GET('/api/v1/credit/applications/{id}/decision', path)),
    unwrap(api.GET('/api/v1/credit/applications/{id}/assignments', path)),
  ]);
  const today = tehranToday();
  const mayComplete = can(session, 'credit.complete_applications');
  const mayScore = can(session, 'credit.score_applications');
  const mayPropose = can(
    session,
    'credit.propose_decision',
    'credit.decide_manager',
    'credit.decide_out_of_matrix',
  );
  const mayVote = can(session, 'credit.committee_vote');
  const status = CREDIT_STATUS[app.status];
  const page = decision.status === 'fulfilled' ? decision.value : null;
  const authority = page?.authority;
  const open = page?.decisions.find((d) => d.status === 'proposed');
  const accepted = (
    personItems: readonly { itemCode: string; document: { status: string } | null }[],
    code: string,
  ) => personItems.find((i) => i.itemCode === code)?.document?.status === 'accepted';

  return (
    <>
      <PageHeader
        title="پرونده اعتباری"
        description={`${app.planTitle} · ${faDigits(app.installmentCount)} قسط`}
      />
      <p>
        <Link href="/credit" className="text-accent underline">
          بازگشت به فهرست
        </Link>
      </p>
      <dl className="grid gap-2 rounded-lg border border-border bg-surface p-4 sm:grid-cols-3">
        <div>
          <dt className="text-ink-muted">وضعیت</dt>
          <dd className="flex flex-wrap gap-1">
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            {app.needsMoreGuarantors && <StatusBadge tone="warning">ضامن بیشتر</StatusBadge>}
          </dd>
        </div>
        <div>
          <dt className="text-ink-muted">وام</dt>
          <dd className="figures font-bold">{toman(app.loanRial)}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">سهم از پیش‌فاکتور</dt>
          <dd className="figures">{toman(app.proformaTotalRial)}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">وام‌گیرنده</dt>
          <dd>{app.borrowerIsPatient ? 'خود بیمار' : 'شخص دیگر'}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">مهلت بررسی</dt>
          <dd className="figures">{app.slaDueAt ? showInstant(app.slaDueAt) : '—'}</dd>
        </div>
        {app.caseGroupId && (
          <div>
            <dt className="text-ink-muted">گروه</dt>
            <dd>
              <Link
                href={`/credit/groups?group=${app.caseGroupId}`}
                className="text-accent underline"
              >
                دیدن گروه
              </Link>
            </dd>
          </div>
        )}
      </dl>
      {assignments.status === 'fulfilled' && assignments.value.length > 0 && (
        <p className="text-[length:var(--text-sm)] text-ink-muted">
          آخرین تخصیص:{' '}
          {assignments.value
            .slice(-1)
            .map(
              (a) =>
                `${QUEUE_LABEL[a.queueCode]} · ${a.kind === 'unassigned' ? 'بدون کارشناس' : 'تخصیص‌یافته'}`,
            )
            .join('')}
        </p>
      )}

      <Section id="documents" title="مدارک">
        {documents.status === 'rejected' ? (
          <Notice tone="danger">{errorMessage(documents.reason)}</Notice>
        ) : (
          documents.value.people.map((p) => (
            <DataTable
              key={p.guarantorId ?? 'borrower'}
              caption={p.role === 'borrower' ? 'وام‌گیرنده' : 'ضامن'}
              rows={p.items}
              rowKey={(i) => i.itemCode}
              empty={<p>مدرکی خواسته نشده است.</p>}
              columns={[
                {
                  key: 'item',
                  header: 'مدرک',
                  cell: (i) => `${i.title}${i.required ? '' : ' (اختیاری)'}`,
                },
                {
                  key: 'state',
                  header: 'وضعیت',
                  cell: (i) =>
                    i.document
                      ? (DOC_STATE[i.document.status] ?? i.document.status)
                      : 'بارگذاری نشده',
                },
                {
                  key: 'actions',
                  header: 'کار',
                  cell: (i) =>
                    i.document ? (
                      <span className="flex flex-wrap gap-2">
                        <ViewDocument id={app.id} documentId={i.document.id} />
                        {mayComplete && i.document.status === 'submitted' && (
                          <DecideDocument id={app.id} documentId={i.document.id} />
                        )}
                      </span>
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
          ))
        )}
        {mayComplete && app.status === 'incomplete' && (
          <PostButton
            path="/api/v1/credit/applications/{id}/ready-for-review"
            id={app.id}
            label="ارسال به بررسی اعتبار"
          />
        )}
      </Section>

      {scoring.status === 'fulfilled' && (
        <Section id="scoring" title="امتیاز">
          <dl className="grid gap-2 sm:grid-cols-3">
            <div>
              <dt className="text-ink-muted">رتبه وام‌گیرنده</dt>
              <dd>
                {scoring.value.sheets.find((s) => s.subject === 'borrower')?.gradeLabel ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">ضمانت لازم</dt>
              <dd>{scoring.value.outcome?.requirement ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">کفایت ضمانت</dt>
              <dd>{scoring.value.outcome?.sufficiency.label ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">مرجع تصمیم (پیشنهاد موتور)</dt>
              <dd>{scoring.value.outcome?.authority?.label ?? '—'}</dd>
            </div>
          </dl>
          {scoring.value.sheets.map((sheet) => {
            const criteria =
              sheet.subject === 'borrower'
                ? scoring.value.criteria.borrower
                : scoring.value.criteria.guarantor;
            const person =
              documents.status === 'fulfilled'
                ? documents.value.people.find((p) =>
                    sheet.subject === 'borrower'
                      ? p.role === 'borrower'
                      : p.guarantorId === sheet.guarantorId,
                  )
                : undefined;
            return (
              <div key={sheet.id} className="space-y-2">
                <h3 className="font-bold">
                  {sheet.subject === 'borrower' ? 'برگه وام‌گیرنده' : 'برگه ضامن'} · جمع{' '}
                  <span className="figures">
                    {sheet.total === null ? '—' : faDigits(sheet.total)}
                  </span>{' '}
                  · رتبه {sheet.gradeLabel ?? '—'}
                  {sheet.stop ? ' · شرط توقف' : ''}
                </h3>
                <DataTable
                  caption="داده خام و مدرک"
                  rows={Object.entries(sheet.rawInputs)}
                  rowKey={([k]) => k}
                  empty={<p>داده خامی ثبت نشده است.</p>}
                  columns={[
                    { key: 'field', header: 'داده', cell: ([k]) => RAW_LABEL[k] ?? k },
                    { key: 'value', header: 'مقدار', cell: ([k, v]) => rawValue(k, v) },
                    {
                      key: 'evidence',
                      header: 'مدرک',
                      cell: ([k]) => {
                        const code = EVIDENCE[k];
                        if (!code) return '—';
                        return person && accepted(person.items, code)
                          ? 'پذیرفته'
                          : 'ادعایی، بی‌مدرک پذیرفته';
                      },
                    },
                  ]}
                />
                <DataTable
                  caption="خروجی موتور برای هر معیار"
                  rows={criteria}
                  rowKey={(c) => c.code}
                  empty={<p>معیاری نیست.</p>}
                  columns={[
                    { key: 'criterion', header: 'معیار', cell: (c) => c.label },
                    {
                      key: 'option',
                      header: 'دسته',
                      cell: (c) =>
                        c.options.find((o) => o.code === sheet.answers[c.code])?.label ?? 'بی‌پاسخ',
                    },
                    {
                      key: 'score',
                      header: 'امتیاز',
                      cell: (c) => {
                        const score = sheet.criteriaScores[c.code];
                        return score === null || score === undefined ? '—' : faDigits(score);
                      },
                      numeric: true,
                    },
                  ]}
                />
              </div>
            );
          })}
          {mayScore && ['ready_for_review', 'scoring', 'manual_review'].includes(app.status) && (
            <>
              <h3 className="font-bold">ثبت داده خام وام‌گیرنده</h3>
              <ScoreForm
                id={app.id}
                subject="borrower"
                criteria={scoring.value.criteria.borrower}
                today={today}
              />
              {scoring.value.guarantors.map((g, n) => (
                <div key={g.id} className="space-y-2">
                  <h3 className="font-bold">ثبت داده خام ضامن {faDigits(n + 1)}</h3>
                  {g.consentAt ? (
                    <ScoreForm
                      id={app.id}
                      subject="guarantor"
                      guarantorId={g.id}
                      criteria={scoring.value.criteria.guarantor}
                      today={today}
                    />
                  ) : (
                    <Notice tone="warning">ضامن هنوز رضایت نداده است.</Notice>
                  )}
                </div>
              ))}
            </>
          )}
        </Section>
      )}

      {page && (
        <Section id="decision" title="تصمیم">
          <dl className="grid gap-2 sm:grid-cols-3">
            <div>
              <dt className="text-ink-muted">مرجع تصمیم (قفل‌شده)</dt>
              <dd>{authority ? AUTHORITY_LABEL[authority] : 'هنوز به تصمیم نرسیده'}</dd>
            </div>
            {page.approvedAmountRial && (
              <div>
                <dt className="text-ink-muted">مبلغ مصوب</dt>
                <dd className="figures font-bold">{toman(page.approvedAmountRial)}</dd>
              </div>
            )}
            {page.conditions && page.conditions.length > 0 && (
              <div>
                <dt className="text-ink-muted">شرط‌ها</dt>
                <dd>{page.conditions.join('، ')}</dd>
              </div>
            )}
          </dl>
          {mayPropose && (app.status === 'ready_for_review' || app.status === 'scoring') && (
            <PostButton
              path="/api/v1/credit/applications/{id}/to-decision"
              id={app.id}
              label="ارسال به تصمیم"
            />
          )}
          {page.decisions.length > 0 && (
            <ul className="space-y-3" aria-label="پیشنهادهای تصمیم">
              {page.decisions.map((d) => (
                <li key={d.id} className="space-y-2 rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{OUTCOME_LABEL[d.outcome] ?? d.outcome}</span>
                    <StatusBadge tone={DECISION_STATE[d.status]?.tone ?? 'neutral'}>
                      {DECISION_STATE[d.status]?.label ?? d.status}
                    </StatusBadge>
                    <span className="text-ink-muted">{AUTHORITY_LABEL[d.authority]}</span>
                    {d.outOfMatrix && <StatusBadge tone="danger">خارج از ماتریس</StatusBadge>}
                  </div>
                  {d.approvedAmountRial && (
                    <p className="figures">مبلغ: {toman(d.approvedAmountRial)}</p>
                  )}
                  {d.decisionReasons && <p>دلیل: {d.decisionReasons.reason}</p>}
                  {d.committee && (
                    <p className="text-[length:var(--text-sm)] text-ink-muted">
                      صورت‌جلسه {d.committee.minutesNumber} · آرا:{' '}
                      {d.committee.votes.length === 0
                        ? 'هنوز رأیی نیست'
                        : d.committee.votes
                            .map(
                              (v) =>
                                `${page.committeeUnits.find((u) => u.code === v.unitCode)?.label ?? v.unitCode}: ${v.vote === 'approve' ? 'موافق' : 'مخالف'}`,
                            )
                            .join('، ')}
                    </p>
                  )}
                  {d.status === 'proposed' && (
                    <DecisionActions
                      id={app.id}
                      decisionId={d.id}
                      mayConfirm={
                        d.authority !== 'committee' || d.outOfMatrix
                          ? can(
                              session,
                              'credit.decide_second_check',
                              'credit.decide_manager',
                              'credit.decide_out_of_matrix',
                            )
                          : false
                      }
                      mayVote={mayVote && d.authority === 'committee'}
                      units={page.committeeUnits}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {mayPropose && app.status === 'manual_review' && !open && (
            <ProposeDecision
              id={app.id}
              committee={authority === 'committee'}
              mayGoOutOfMatrix={can(session, 'credit.decide_out_of_matrix')}
              reasons={page.rejectionReasons}
              today={today}
            />
          )}
        </Section>
      )}
      {/* ADR-050: a wage-only case's split, checked before its decision. */}
      <CostSplitSection applicationId={app.id} />
      {(app.status === 'approved' || app.status === 'conditional') && (
        <PenaltySection applicationId={app.id} />
      )}
    </>
  );
}
