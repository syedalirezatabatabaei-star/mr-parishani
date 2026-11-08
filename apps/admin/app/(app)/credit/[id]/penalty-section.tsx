import { unwrap } from '@sepehr/api-client';
import { DataTable, faDigits, Notice, showInstant, StatusBadge, type StatusTone } from '@sepehr/ui';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { AskPenaltyOverride, Decide } from '../../special-operations/operation-actions';

const STATUS: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  requested: { label: 'در انتظار تأیید', tone: 'warning' },
  approved: { label: 'تأیید شد', tone: 'success' },
  rejected: { label: 'رد شد', tone: 'danger' },
};
const percent = (bps: number) => `${faDigits((bps / 100).toFixed(bps % 100 === 0 ? 0 : 2))}٪`;

/**
 * A case's own cancellation-penalty rate (task 4-8, owner پ۱۳; ADR-044): asked by accounting,
 * approved by the general manager; the contract made after it locks it (owner س۴). Once a
 * contract exists, no rate is asked (the API says so).
 */
export async function PenaltySection({ applicationId }: { applicationId: string }) {
  const [api, session] = await Promise.all([serverApi(), getSession()]);
  const mayAsk = can(session, 'credit.request_penalty_override');
  const mayDecide = can(session, 'credit.approve_penalty_override');
  if (!mayAsk && !mayDecide) return null;
  let rows;
  try {
    rows = await unwrap(
      api.GET('/api/v1/credit/applications/{id}/penalty-overrides', {
        params: { path: { id: applicationId } },
      }),
    );
  } catch {
    return null;
  }
  const open = rows.some((r) => r.status === 'requested');
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      aria-labelledby="penalty"
    >
      <h2 id="penalty" className="text-[length:var(--text-lg)] font-bold">
        نرخ خسارت انصراف این پرونده
      </h2>
      <Notice tone="info">
        بی درخواست تأییدشده، نرخ پیکربندی به کار می‌رود. نرخ هنگام ساخت قرارداد قفل می‌شود.
      </Notice>
      <DataTable
        caption="درخواست‌های نرخ خسارت"
        rows={rows}
        rowKey={(r) => r.id}
        empty={<p>درخواستی ثبت نشده است.</p>}
        columns={[
          { key: 'asked', header: 'درخواست', cell: (r) => showInstant(r.requestedAt) },
          { key: 'rate', header: 'نرخ', cell: (r) => percent(r.penaltyBps), numeric: true },
          { key: 'reason', header: 'دلیل', cell: (r) => r.reason },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (r) => (
              <StatusBadge tone={STATUS[r.status]?.tone ?? 'neutral'}>
                {STATUS[r.status]?.label ?? r.status}
              </StatusBadge>
            ),
          },
          {
            key: 'decide',
            header: 'تصمیم',
            cell: (r) =>
              r.status === 'requested' && mayDecide ? (
                <Decide
                  target={{ kind: 'penalty_override', id: r.id }}
                  mine={r.requestedByMe}
                  approveLabel="تأیید نرخ"
                />
              ) : (
                '—'
              ),
          },
        ]}
      />
      {mayAsk && !open && <AskPenaltyOverride applicationId={applicationId} />}
    </section>
  );
}
