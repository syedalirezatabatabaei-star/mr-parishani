import { unwrap } from '@sepehr/api-client';
import { EmptyState, errorMessage, faDigits, Notice, PageHeader, StatusBadge } from '@sepehr/ui';
import type { Metadata } from 'next';
import { getWorkplaces, workplaceLabel } from '../../../../lib/panel';
import { can, getSession, serverApi } from '../../../../lib/server-api';
import { SecretaryRole } from './secretary-role';

export const metadata: Metadata = {
  title: 'پزشکان و منشی‌ها | پنل مرکز',
  robots: { index: false, follow: false },
};

/**
 * The doctors of the caller's center (or the caller themselves) with their workplaces and
 * secretaries (doc 04 §2). A doctor sees no other doctor (rule 13); the API decides.
 * TODO(decision): accounts for new staff are made by the CLI for now; inviting a doctor or
 * a secretary from the panel (and their first sign-in) is a later step.
 */
export default async function PanelStaffPage() {
  const [session, workplaces] = await Promise.all([getSession(), getWorkplaces()]);
  const api = await serverApi();
  const [listed] = await Promise.allSettled([unwrap(api.GET('/api/v1/catalog/doctors'))]);
  const canDelegate = can(session, 'catalog.manage_doctors');
  const places = new Map(workplaces.map((w) => [w.workplaceId, workplaceLabel(w)]));

  if (listed.status === 'rejected') {
    return (
      <>
        <PageHeader title="پزشکان و منشی‌ها" />
        <Notice tone="danger">{errorMessage(listed.reason)}</Notice>
      </>
    );
  }
  const list = listed.value;
  // Each doctor's workplaces and secretaries (an audited view of each doctor, doc 04 §7).
  const details = await Promise.all(
    list.map((d) =>
      unwrap(api.GET('/api/v1/catalog/doctors/{id}', { params: { path: { id: d.id } } })).catch(
        () => null,
      ),
    ),
  );

  return (
    <>
      <PageHeader title="پزشکان و منشی‌ها" />
      {list.length === 0 ? (
        <EmptyState title="پزشکی در دسترس شما نیست." />
      ) : (
        <ul className="space-y-4">
          {list.map((doctor, i) => {
            const detail = details[i];
            return (
              <li
                key={doctor.id}
                className="space-y-3 rounded-lg border border-border bg-surface p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-bold">{doctor.name}</p>
                    <p className="text-[length:var(--text-sm)] text-ink-muted">
                      نظام پزشکی:{' '}
                      <span className="figures">{faDigits(doctor.medicalCouncilNumber)}</span>
                    </p>
                  </div>
                  <StatusBadge tone={doctor.hasAccount ? 'success' : 'neutral'}>
                    {doctor.hasAccount ? 'حساب کاربری دارد' : 'بدون حساب کاربری'}
                  </StatusBadge>
                </div>
                {detail && (
                  <>
                    <div>
                      <p className="text-[length:var(--text-sm)] font-medium">محل‌های کار</p>
                      <ul className="list-inside list-disc text-[length:var(--text-sm)]">
                        {detail.workplaces.map((w) => (
                          <li key={w.id}>{places.get(w.id) ?? 'محل کاری بیرون از دسترس شما'}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="space-y-2">
                      <p className="text-[length:var(--text-sm)] font-medium">منشی‌ها</p>
                      {detail.secretaries.length === 0 ? (
                        <p className="text-[length:var(--text-sm)] text-ink-muted">
                          منشی ثبت نشده است.
                        </p>
                      ) : (
                        <ul className="space-y-2">
                          {detail.secretaries.map((s) => (
                            <li
                              key={s.id}
                              className="flex flex-wrap items-center justify-between gap-2"
                            >
                              <span>
                                {s.name}
                                <span className="text-[length:var(--text-sm)] text-ink-muted">
                                  {' '}
                                  ({places.get(s.workplaceId) ?? ''})
                                </span>
                              </span>
                              {canDelegate && !doctor.hasAccount && (
                                <SecretaryRole secretaryId={s.id} />
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
