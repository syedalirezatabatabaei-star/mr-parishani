import { EmptyState, errorMessage, Notice, PageHeader } from '@sepehr/ui';
import type { Metadata } from 'next';
import { chosenWorkplace, getWorkplaces, workplaceLabel } from '../../../../../lib/panel';
import { one, type SearchParams } from '../../../../../lib/params';
import { pricedServices } from '../priced-services';
import { ProformaEditor, type PricedService } from '../proforma-editor';

export const metadata: Metadata = {
  title: 'پیش‌فاکتور تازه | پنل مرکز',
  robots: { index: false, follow: false },
};

/**
 * A new proforma for the patient of an appointment (doc 10 §2: only for a patient
 * referred through Sepehr; the API checks the referral). Reached from the appointments
 * page with `?appointment=…&workplace=…`.
 */
export default async function NewProformaPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const appointmentId = one(params, 'appointment');
  const workplace = chosenWorkplace(await getWorkplaces(), params);
  if (!appointmentId || !workplace) {
    return (
      <>
        <PageHeader title="پیش‌فاکتور تازه" />
        <EmptyState title="پیش‌فاکتور از صفحه نوبت‌ها و برای نوبت بیمار صادر می‌شود." />
      </>
    );
  }
  let services: PricedService[] = [];
  let failure: unknown = null;
  try {
    services = await pricedServices(workplace.workplaceId);
  } catch (error) {
    failure = error;
  }
  return (
    <>
      <PageHeader title="پیش‌فاکتور تازه" description={workplaceLabel(workplace)} />
      {failure ? (
        <Notice tone="danger">{errorMessage(failure)}</Notice>
      ) : (
        <ProformaEditor target={{ kind: 'create', appointmentId }} services={services} />
      )}
    </>
  );
}
