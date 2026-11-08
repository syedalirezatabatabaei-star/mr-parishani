import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  Notice,
  PageHeader,
  rial,
  SERVICE_STATUS,
  showInstant,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { serverApi } from '../../../lib/server-api';
import { CancelService } from './cancel-service';

export const metadata: Metadata = { title: 'مجوزهای خدمت | پنل داخلی سپهر' };

/**
 * Service authorizations for finance (doc 12 §6; task 4-7): newest first, what each
 * authorized and where it stands. Cancelling is finance's only, with a reason, and only
 * before the service is final (owner, task 4-6 پ۳ and ت۲).
 */
export default async function ServicesPage() {
  const api = await serverApi();
  let authorizations;
  try {
    authorizations = await unwrap(api.GET('/api/v1/service/authorizations'));
  } catch (error) {
    return (
      <>
        <PageHeader title="مجوزهای خدمت" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="مجوزهای خدمت"
        description="مجوزهای صادرشده پزشکان روی کیف اعتبار بیماران؛ لغو فقط پیش از قطعی شدن."
      />
      <DataTable
        caption="مجوزهای خدمت"
        rows={authorizations}
        rowKey={(a) => a.id}
        empty={<EmptyState title="مجوزی صادر نشده است." />}
        columns={[
          { key: 'issued', header: 'صدور', cell: (a) => showInstant(a.issuedAt) },
          { key: 'amount', header: 'مبلغ', cell: (a) => rial(a.amountRial), numeric: true },
          {
            key: 'status',
            header: 'وضعیت',
            cell: (a) => (
              <StatusBadge tone={SERVICE_STATUS[a.status].tone}>
                {SERVICE_STATUS[a.status].label}
              </StatusBadge>
            ),
          },
          {
            key: 'delivered',
            header: 'ثبت',
            cell: (a) => (a.deliveredAt ? showInstant(a.deliveredAt) : '—'),
          },
          {
            key: 'cancel',
            header: 'لغو',
            cell: (a) =>
              a.status === 'code_sent' || a.status === 'delivered' ? (
                <CancelService id={a.id} />
              ) : a.status === 'cancelled' ? (
                (a.cancelReason ?? '—')
              ) : (
                '—'
              ),
          },
        ]}
      />
    </>
  );
}
