import { unwrap } from '@sepehr/api-client';
import {
  DataTable,
  Notice,
  PageHeader,
  showDay,
  showInstant,
  StatusBadge,
  tehranToday,
} from '@sepehr/ui';
import type { Metadata } from 'next';
import { can, getSession, serverApi } from '../../../lib/server-api';
import { FindMember, RecordMembership, RevokeMembership } from './club-forms';

export const metadata: Metadata = { title: 'باشگاه مشتریان | پنل داخلی سپهر' };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The customer club (ADR-048; owner 1405/07/30, answer 2): a club officer finds a person by
 * mobile, records a membership with its first and last day and why, or ends one early. Rows
 * never change; a club plan is offered only to a member on the case's day, and locked on it.
 */
export default async function ClubPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [api, session, params] = await Promise.all([serverApi(), getSession(), searchParams]);
  if (!can(session, 'lead.record_club_membership')) {
    return (
      <>
        <PageHeader title="باشگاه مشتریان" />
        <Notice tone="danger">اجازه این بخش را ندارید.</Notice>
      </>
    );
  }
  const raw = params['mobile'];
  const mobile = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  const memberships = mobile
    ? await unwrap(
        api.GET('/api/v1/lead/club-memberships', { params: { query: { mobile } } }),
      ).catch(() => null)
    : [];
  const today = tehranToday();
  return (
    <>
      <PageHeader
        title="باشگاه مشتریان"
        description="عضویت با روز شروع و پایان، ثبت‌کننده و دلیل ثبت می‌شود و هرگز ویرایش نمی‌شود؛ پایان زودتر با لغو جدا."
      />
      <FindMember mobile={mobile} />
      {memberships === null && (
        <Notice tone="danger">شخصی با این شماره پیدا نشد، یا شماره درست نیست.</Notice>
      )}
      {mobile && memberships !== null && (
        <>
          <RecordMembership mobile={mobile} today={today} />
          <DataTable
            caption="عضویت‌ها"
            rows={memberships}
            rowKey={(m) => m.id}
            empty={<p>عضویتی ثبت نشده است.</p>}
            columns={[
              { key: 'from', header: 'از', cell: (m) => showDay(m.startsOn) },
              { key: 'to', header: 'تا', cell: (m) => (m.endsOn ? showDay(m.endsOn) : 'باز') },
              { key: 'reason', header: 'دلیل', cell: (m) => m.reason },
              { key: 'at', header: 'ثبت', cell: (m) => showInstant(m.recordedAt) },
              {
                key: 'state',
                header: 'وضعیت',
                cell: (m) =>
                  m.revocation ? (
                    <StatusBadge tone="neutral">
                      لغو از {showDay(m.revocation.revokedOn)}: {m.revocation.reason}
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone={m.activeToday ? 'success' : 'warning'}>
                      {m.activeToday ? 'عضو امروز' : 'خارج از بازه'}
                    </StatusBadge>
                  ),
              },
              {
                key: 'revoke',
                header: 'لغو',
                cell: (m) => (m.revocation ? '—' : <RevokeMembership id={m.id} today={today} />),
              },
            ]}
          />
        </>
      )}
    </>
  );
}
