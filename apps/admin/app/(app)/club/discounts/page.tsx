import { unwrap } from '@sepehr/api-client';
import { errorMessage, FilterBar, Notice, PageHeader, TextField } from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { OriginationSection } from '../../completion/[id]/origination-section';

export const metadata: Metadata = { title: 'تخفیف تشکیل پرونده | پنل داخلی سپهر' };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Owner 1405/08/02 (plan pilot-panel-gaps-plan.md item ب): the club officer, who cannot open
 * the completion page, finds a person's cases by mobile and grants the origination discount
 * there, under their own signature, at most the plan's (ADR-048). The same section and rules
 * as the completion page; the API checks them again.
 */
export default async function ClubDiscountsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [api, session, params] = await Promise.all([serverApi(), getSession(), searchParams]);
  if (!can(session, 'contract.grant_origination_discount')) {
    return (
      <>
        <PageHeader title="تخفیف تشکیل پرونده" />
        <Notice tone="danger">اجازه این بخش را ندارید.</Notice>
      </>
    );
  }
  const raw = params['mobile'];
  const mobile = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  let found: Awaited<ReturnType<typeof search>> | null = null;
  let failure: unknown = null;
  async function search() {
    return unwrap(
      api.GET('/api/v1/origination-discounts/candidates', { params: { query: { mobile } } }),
    );
  }
  if (mobile) {
    try {
      found = await search();
    } catch (error) {
      failure = error;
    }
  }
  return (
    <>
      <PageHeader
        title="تخفیف تشکیل پرونده"
        description="پرونده‌های تأییدشده‌ای که هزینه تشکیلشان هنوز قفل نشده است؛ تخفیف با امضای شما و حداکثر به اندازه طرح."
      />
      <FilterBar action="/club/discounts" label="جست‌وجوی پرونده" submitLabel="جست‌وجو">
        <TextField
          id="mobile"
          name="mobile"
          label="موبایل بیمار یا وام‌گیرنده"
          defaultValue={mobile}
          inputMode="tel"
          required
          figures
        />
      </FilterBar>
      {failure !== null && <Notice tone="danger">{errorMessage(failure)}</Notice>}
      {found !== null && found.length === 0 && (
        <Notice tone="info">پرونده‌ای که هنوز تخفیف بپذیرد برای این شماره نیست.</Notice>
      )}
      {found?.map((c, i) => (
        <article key={c.creditApplicationId} className="space-y-2">
          <p className="text-[length:var(--text-sm)] text-ink-muted">
            طرح: {c.planTitle} ·{' '}
            <span dir="ltr" className="figures">
              {c.creditApplicationId.slice(-8)}
            </span>
          </p>
          <OriginationSection
            applicationId={c.creditApplicationId}
            origination={c.origination}
            headingId={`origination-${String(i)}`}
          />
        </article>
      ))}
    </>
  );
}
