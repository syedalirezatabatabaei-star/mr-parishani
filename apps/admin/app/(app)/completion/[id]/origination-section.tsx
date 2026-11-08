import type { OriginationOwed } from '@sepehr/contracts';
import { faDigits, Notice, rial, showInstant, StatusBadge } from '@sepehr/ui';
import { can, getSession } from '../../../../lib/server-api';
import { GrantOriginationDiscount } from './origination-actions';

const percent = (bps: number) => `${faDigits((bps / 100).toFixed(bps % 100 === 0 ? 0 : 2))}٪`;

/**
 * ADR-048: the origination fee owed, its waiver with the borrower's checked cheques and an
 * officer's discount under their signature (no second person). Live until its receipt is
 * uploaded, or the case is completed with nothing to pay; then locked.
 */
export async function OriginationSection({
  applicationId,
  origination,
  headingId = 'origination',
}: {
  applicationId: string;
  origination: OriginationOwed | null;
  /** Unique on the page: the club's list shows one section per case. */
  headingId?: string;
}) {
  if (!origination) return null;
  const session = await getSession();
  const mayGrant =
    can(session, 'contract.grant_origination_discount') &&
    !origination.locked &&
    origination.maxDiscountBps > 0;
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-labelledby={headingId}
    >
      <h2
        id={headingId}
        className="flex items-center gap-2 text-[length:var(--text-lg)] font-bold"
      >
        هزینه تشکیل پرونده
        <StatusBadge tone={origination.locked ? 'success' : 'neutral'}>
          {origination.locked ? 'مبلغ قفل شد' : 'تا بارگذاری فیش تغییرپذیر'}
        </StatusBadge>
      </h2>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="text-ink-muted">هزینه تشکیل</dt>
        <dd className="figures">{rial(origination.feeRial)}</dd>
        <dt className="text-ink-muted">مبنا</dt>
        <dd className="figures">{rial(origination.baseRial)}</dd>
        <dt className="text-ink-muted">چک‌های بررسی‌شده وام‌گیرنده</dt>
        <dd className="figures">
          {faDigits(String(origination.chequeCount))}
          {origination.minCheques !== null
            ? ` از ${faDigits(String(origination.minCheques))} لازم برای بخشودگی`
            : ' (این طرح بخشودگی با چک ندارد)'}
        </dd>
        <dt className="text-ink-muted">بخشودگی</dt>
        <dd className="figures">{percent(origination.waiverBps)}</dd>
        <dt className="text-ink-muted">تخفیف مسئول</dt>
        <dd className="figures">{percent(origination.discountBps)}</dd>
        <dt className="text-ink-muted">قابل پرداخت</dt>
        <dd className="figures font-bold">{rial(origination.netRial)}</dd>
      </dl>
      {origination.discount && (
        <Notice tone="info">
          تخفیف {percent(origination.discount.discountBps)} با امضای{' '}
          {origination.discount.grantedByName ?? 'مسئول'}،{' '}
          {showInstant(origination.discount.createdAt)}: {origination.discount.reason}
        </Notice>
      )}
      {origination.netRial === '0' && !origination.locked && (
        <p className="text-ink-muted">
          چیزی برای پرداخت نمانده است؛ مبلغ هنگام تکمیل پرونده قفل می‌شود.
        </p>
      )}
      {mayGrant && (
        <GrantOriginationDiscount
          applicationId={applicationId}
          maxDiscountBps={origination.maxDiscountBps}
        />
      )}
    </section>
  );
}
