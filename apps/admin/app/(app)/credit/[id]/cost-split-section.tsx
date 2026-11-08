import { unwrap } from '@sepehr/api-client';
import { Notice, rial, showInstant, StatusBadge } from '@sepehr/ui';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { ReviewCostSplit } from './cost-split-actions';

/**
 * ADR-050: a wage-only case's split of the doctor's wage and the materials, checked once by
 * credit or case completion before its decision. The materials are paid to the doctor in cash,
 * recorded on the case only. Shown only for a wage-only plan.
 */
export async function CostSplitSection({ applicationId }: { applicationId: string }) {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const mayReview = can(session, 'credit.review_cost_split');
  if (!mayReview && !can(session, 'credit.read_applications')) return null;
  let state;
  try {
    state = await unwrap(
      api.GET('/api/v1/credit/applications/{id}/cost-split', {
        params: { path: { id: applicationId } },
      }),
    );
  } catch {
    return null;
  }
  if (!state.wageOnly) return null;
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-labelledby="cost-split"
    >
      <h2
        id="cost-split"
        className="flex items-center gap-2 text-[length:var(--text-lg)] font-bold"
      >
        تفکیک دستمزد و مواد
        <StatusBadge tone={state.review ? 'success' : 'warning'}>
          {state.review ? 'بررسی شد' : 'منتظر بررسی'}
        </StatusBadge>
      </h2>
      <Notice tone="info">
        وام این طرح فقط دستمزد پزشک است. هزینه مواد را بیمار نقد به پزشک می‌دهد و فقط روی پرونده ثبت
        می‌شود. تصمیم تا بررسی این تفکیک صبر می‌کند.
      </Notice>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="text-ink-muted">دستمزد پزشک (مبنای وام)</dt>
        <dd className="figures">{state.wageRial === null ? '—' : rial(state.wageRial)}</dd>
        <dt className="text-ink-muted">هزینه مواد (نقد به پزشک)</dt>
        <dd className="figures">{rial(state.materialCashRial)}</dd>
        {state.review && (
          <>
            <dt className="text-ink-muted">بررسی</dt>
            <dd>
              <span className="figures">{showInstant(state.review.reviewedAt)}</span>:{' '}
              {state.review.note}
            </dd>
          </>
        )}
      </dl>
      {!state.review && mayReview && <ReviewCostSplit applicationId={applicationId} />}
    </section>
  );
}
