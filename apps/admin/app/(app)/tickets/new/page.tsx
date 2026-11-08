import { unwrap } from '@sepehr/api-client';
import { errorMessage, Notice, PageHeader } from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../../lib/server-api';
import { OnBehalfForm } from './on-behalf-form';

export const metadata: Metadata = { title: 'ثبت تیکت از طرف تماس‌گیرنده | پنل داخلی سپهر' };

/** A caller's ticket, written by staff (task 7-7; ticket.open_on_behalf). */
export default async function NewStaffTicketPage() {
  const api = await serverApi();
  let topics;
  try {
    topics = await unwrap(api.GET('/api/v1/tickets/topics'));
  } catch (error) {
    return (
      <>
        <PageHeader title="ثبت از طرف تماس‌گیرنده" />
        <Notice tone="danger">{errorMessage(error)}</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="ثبت از طرف تماس‌گیرنده"
        description="تیکت به نام تماس‌گیرنده ثبت می‌شود و او آن را در پنل خود می‌بیند."
      />
      <Link href="/tickets" className="text-accent underline">
        بازگشت به صف
      </Link>
      <OnBehalfForm topics={topics} />
    </>
  );
}
