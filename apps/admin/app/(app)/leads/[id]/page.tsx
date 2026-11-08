import { ApiError, unwrap } from '@sepehr/api-client';
import { OPEN_CASE_STATUSES } from '@sepehr/contracts';
import {
  buttonClass,
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
import { notFound } from 'next/navigation';
import { cityNamer } from '../../../../lib/cities';
import {
  APPOINTMENT_STATUS,
  CASE_STATUS,
  dialMobile,
  INTAKE_CATEGORY,
} from '../../../../lib/leads';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import {
  BlockPerson,
  CancelCase,
  HandOffCase,
  MergePersons,
  SmsOptOut,
  StartAdvising,
} from '../lead-forms';

export const metadata: Metadata = { title: 'پرونده | پنل داخلی سپهر' };

/** A label by a code the API gives as text; undefined for a code this page does not know. */
const labelOf = <T,>(labels: Readonly<Record<string, T>>, code: string): T | undefined =>
  Object.hasOwn(labels, code) ? labels[code] : undefined;

/**
 * One case as its advisor works it (owner 1405/07/24, م۹): the person and how to reach them,
 * the history, the next step, closing with a reason from the list, the appointments booked
 * for it, and booking one for the patient. A case outside the viewer's scope does not exist
 * (404, rule 13). No credit detail is shown here (doc 04: the advisor sees status only).
 */
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [api, session, cityName] = await Promise.all([serverApi(), getSession(), cityNamer()]);
  const kase = await unwrap(api.GET('/api/v1/lead/cases/{id}', { params: { path: { id } } })).catch(
    (error: unknown) => {
      if (error instanceof ApiError && error.notFound) notFound();
      throw error;
    },
  );
  const mayUpdate = can(session, 'lead.update_cases');
  const mayBook = can(session, 'booking.book_for_patient');
  // The agent is found by username on the assignment page's lookup (lead.manage_assignment).
  const mayHandOff = can(session, 'lead.assign_manually') && can(session, 'lead.manage_assignment');
  const mayMerge = can(session, 'lead.merge_persons');
  const open = OPEN_CASE_STATUSES.includes(kase.status);
  const [reasons, appointments, fields, merges] = await Promise.allSettled([
    mayUpdate && open ? unwrap(api.GET('/api/v1/lead/abandonment-reasons')) : Promise.resolve([]),
    mayBook
      ? unwrap(
          api.GET('/api/v1/booking/advisor/cases/{id}/appointments', { params: { path: { id } } }),
        )
      : Promise.resolve([]),
    unwrap(api.GET('/api/v1/catalog/fields')),
    mayMerge
      ? unwrap(
          api.GET('/api/v1/lead/persons/{id}/merges', { params: { path: { id: kase.personId } } }),
        )
      : Promise.resolve([]),
  ]);
  const fieldName =
    fields.status === 'fulfilled'
      ? (fields.value.find((f) => f.code === kase.treatmentFieldCode)?.name ??
        kase.treatmentFieldCode)
      : kase.treatmentFieldCode;
  const status = CASE_STATUS[kase.status];
  const person = kase.person;

  return (
    <>
      <PageHeader
        title={person.displayName ?? 'پرونده بی نام'}
        description={[fieldName, kase.cityCode ? cityName(kase.cityCode) : null]
          .filter(Boolean)
          .join(' · ')}
      />
      <div className="space-y-6">
        <section
          aria-labelledby="case-person"
          className="space-y-2 rounded-lg border border-border bg-surface p-4"
        >
          <h2 id="case-person" className="text-[length:var(--text-lg)] font-bold">
            شخص و وضعیت
          </h2>
          <p className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            {kase.isReturning && <StatusBadge tone="info">بازگشتی</StatusBadge>}
            {person.blocked && <StatusBadge tone="danger">مسدود</StatusBadge>}
            {person.smsOptedOutAt && <StatusBadge tone="neutral">بی پیامک</StatusBadge>}
          </p>
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">موبایل</dt>
              <dd>
                {person.mobiles.length === 0
                  ? '—'
                  : person.mobiles.map((m) => (
                      <a
                        key={m}
                        href={`tel:${dialMobile(m)}`}
                        dir="ltr"
                        className="me-3 text-accent"
                      >
                        {faDigits(dialMobile(m))}
                      </a>
                    ))}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">کد ملی</dt>
              <dd dir="ltr">
                {person.nationalIdLast4 ? faDigits(`…${person.nationalIdLast4}`) : '—'}
              </dd>
            </div>
          </dl>
          {person.pendingMobiles.length > 0 && (
            <Notice tone="warning">
              {faDigits(String(person.pendingMobiles.length))} موبایل افزوده‌شده هنوز تأیید نشده است
              و تا تأیید از آن استفاده نکنید.
            </Notice>
          )}
          {kase.previous && (
            <p className="text-[length:var(--text-sm)] text-ink-muted">
              پرونده قبلی تا «{CASE_STATUS[kase.previous.status].label}» رفت
              {kase.previous.closedAt && <> و در {showInstant(kase.previous.closedAt)} بسته شد</>}.
            </p>
          )}
        </section>

        {mayUpdate && kase.status === 'new' && <StartAdvising caseId={kase.id} />}

        {mayBook && (
          <section aria-labelledby="case-appointments" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="case-appointments" className="text-[length:var(--text-lg)] font-bold">
                نوبت‌ها
              </h2>
              {open && !person.blocked && person.mobiles.length > 0 && (
                <Link href={`/leads/${kase.id}/book`} className={buttonClass('primary')}>
                  نوبت برای بیمار
                </Link>
              )}
            </div>
            {appointments.status === 'rejected' ? (
              <Notice tone="danger">{errorMessage(appointments.reason)}</Notice>
            ) : (
              <DataTable
                caption="نوبت‌های این پرونده"
                rows={appointments.value}
                rowKey={(a) => a.id}
                empty={<EmptyState title="نوبتی گرفته نشده است." />}
                columns={[
                  {
                    key: 'at',
                    header: 'زمان',
                    cell: (a) => <time dateTime={a.startsAt}>{showInstant(a.startsAt)}</time>,
                  },
                  {
                    key: 'status',
                    header: 'وضعیت',
                    cell: (a) => (
                      <StatusBadge tone={APPOINTMENT_STATUS[a.status].tone}>
                        {APPOINTMENT_STATUS[a.status].label}
                      </StatusBadge>
                    ),
                  },
                ]}
              />
            )}
          </section>
        )}

        <DataTable
          caption="سابقه وضعیت"
          rows={kase.statusChanges}
          rowKey={(c) => `${c.at}-${c.to}`}
          empty={<EmptyState title="بی تغییر." />}
          columns={[
            {
              key: 'at',
              header: 'زمان',
              cell: (c) => <time dateTime={c.at}>{showInstant(c.at)}</time>,
            },
            {
              key: 'to',
              header: 'به',
              cell: (c) => labelOf(CASE_STATUS, c.to)?.label ?? c.to,
            },
          ]}
        />
        <DataTable
          caption="ورودی‌ها"
          rows={kase.intakes}
          rowKey={(i) => i.id}
          empty={<EmptyState title="—" />}
          columns={[
            {
              key: 'at',
              header: 'زمان',
              cell: (i) => <time dateTime={i.at}>{showInstant(i.at)}</time>,
            },
            {
              key: 'category',
              header: 'نوع',
              cell: (i) => labelOf(INTAKE_CATEGORY, i.category) ?? i.category,
            },
          ]}
        />

        {mayUpdate && open && (
          <>
            {reasons.status === 'fulfilled' && (
              <CancelCase
                caseId={kase.id}
                reasons={reasons.value.map((r) => ({ value: r.code, label: r.title }))}
              />
            )}
            {!person.smsOptedOutAt && <SmsOptOut caseId={kase.id} />}
          </>
        )}
        {mayHandOff && open && <HandOffCase caseId={kase.id} />}
        {can(session, 'lead.block_person') && (
          <BlockPerson personId={person.id} blocked={person.blocked !== null} />
        )}
        {mayMerge &&
          (merges.status === 'rejected' ? (
            <Notice tone="danger">{errorMessage(merges.reason)}</Notice>
          ) : (
            <MergePersons
              personId={kase.personId}
              merges={merges.value.map((m) => ({
                id: m.id,
                movedCount: m.movedCaseIds.length,
                reason: m.reason,
                at: m.at,
                reverted: m.revertedAt !== null,
              }))}
            />
          ))}
      </div>
    </>
  );
}
