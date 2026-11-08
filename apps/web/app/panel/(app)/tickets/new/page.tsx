import { unwrap } from '@sepehr/api-client';
import {
  errorMessage,
  NewTicketForm,
  Notice,
  PageHeader,
  showInstantDay,
  toman,
  type TicketLinkOption,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getSession, serverApi } from '../../../../../lib/server-api';
import { ITEM_KIND } from '../../settlement/labels';

export const metadata: Metadata = {
  title: 'تیکت تازه | پنل مرکز',
  robots: { index: false, follow: false },
};

/**
 * A center's new ticket (task 7-7). A financial complaint names one of the doctor's own
 * coming settlement items, which it holds until accounting decides (7-2; doc 17 §1).
 */
export default async function NewPanelTicketPage() {
  const session = await getSession();
  const own = session?.access.permissions.includes('settlement.read_own') ?? false;
  const api = await serverApi();
  let topics;
  let items: TicketLinkOption[];
  try {
    const [t, upcoming] = await Promise.all([
      unwrap(api.GET('/api/v1/panel/tickets/topics')),
      own ? unwrap(api.GET('/api/v1/settlement/panel/upcoming')) : [],
    ]);
    topics = own ? t : t.filter((x) => !x.financial);
    items = upcoming.map((i) => ({
      type: i.subjectType,
      id: i.itemId,
      label: `${ITEM_KIND[i.kind]}، ${showInstantDay(i.occurredAt)}، ${toman(i.amountRial)}`,
    }));
  } catch (error) {
    return (
      <>
        <PageHeader title="تیکت تازه" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="تیکت تازه"
        description="برای اعتراض به یک قلم تسویه، موضوع «شکایت مالی» را انتخاب کنید."
      />
      <Link href="/panel/tickets" className="text-accent underline">
        بازگشت به تیکت‌ها
      </Link>
      <NewTicketForm
        side="panel"
        topics={topics}
        links={[]}
        financialItems={items}
        hrefBase="/panel/tickets"
      />
    </>
  );
}
