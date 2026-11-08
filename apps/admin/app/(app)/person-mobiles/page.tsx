import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  EmptyState,
  errorMessage,
  faDigits,
  Notice,
  PageHeader,
  showInstant,
  StatusBadge,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { serverApi } from '../../../lib/server-api';
import { ADDED_VIA } from './added-via';

export const metadata: Metadata = { title: 'موبایل‌های در انتظار تأیید | پنل داخلی سپهر' };

/**
 * Task 9-3 (go-live blocker م۵, method ب): mobiles added to a Person who already existed, by
 * national ID, waiting for a decision. They give nothing of the Person until approved. The
 * queue shows the last four digits only, masked by the API (owner 1405/07/23); the whole
 * number and the decision are on each mobile's page. Staff with `lead.approve_person_mobile`
 * approve by two people, never a mobile they added themselves, after the TOTP code again (R1);
 * where the Person has a proved mobile, its holder can decide in their own panel instead.
 */
export default async function PersonMobilesPage() {
  const api = await serverApi();
  const [list] = await Promise.allSettled([unwrap(api.GET('/api/v1/lead/person-mobiles/pending'))]);
  return (
    <>
      <PageHeader
        title="موبایل‌های در انتظار تأیید"
        description="شماره‌ای که با کد ملی به شخص موجود افزوده شده، تا تأیید به هیچ اطلاعاتی از آن شخص دسترسی ندارد و پیامکی نمی‌گیرد."
      />
      {list.status === 'rejected' ? (
        <Notice tone="danger">{errorMessage(list.reason)}</Notice>
      ) : (
        <DataTable
          caption="موبایل‌های در انتظار تأیید"
          rows={list.value}
          rowKey={(m) => m.id}
          empty={<EmptyState title="موبایلی در انتظار تأیید نیست." />}
          columns={[
            {
              key: 'mobile',
              header: 'شماره',
              cell: (m) => <span dir="ltr">{faDigits(`…${m.mobileLast4}`)}</span>,
            },
            {
              key: 'via',
              header: 'از راه',
              cell: (m) => (m.addedVia ? (ADDED_VIA[m.addedVia] ?? m.addedVia) : '—'),
            },
            {
              key: 'added',
              header: 'افزوده در',
              cell: (m) => <time dateTime={m.addedAt}>{showInstant(m.addedAt)}</time>,
            },
            {
              key: 'expires',
              header: 'رد خودکار در',
              cell: (m) =>
                m.expiresAt ? <time dateTime={m.expiresAt}>{showInstant(m.expiresAt)}</time> : '—',
            },
            {
              key: 'owner',
              header: 'صاحب حساب',
              cell: (m) =>
                m.hasProvedMobile ? (
                  <StatusBadge tone="info">می‌تواند خودش تأیید کند</StatusBadge>
                ) : (
                  <StatusBadge tone="warning">فقط با مدرک</StatusBadge>
                ),
            },
            {
              key: 'proposal',
              header: 'دونفره',
              cell: (m) =>
                m.proposal ? (
                  <StatusBadge tone="info">پیشنهادشده، منتظر نفر دوم</StatusBadge>
                ) : (
                  <StatusBadge tone="neutral">بی پیشنهاد</StatusBadge>
                ),
            },
            {
              key: 'decide',
              header: 'تصمیم',
              cell: (m) => (
                <Link
                  href={`/person-mobiles/${m.id}`}
                  className="font-medium text-accent hover:underline"
                >
                  بررسی و تصمیم
                </Link>
              ),
            },
          ]}
        />
      )}
    </>
  );
}
