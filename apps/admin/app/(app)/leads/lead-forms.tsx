'use client';

import { ApiError, unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  CheckboxField,
  errorMessage,
  faDigits,
  formText,
  Notice,
  SelectField,
  showInstant,
  TextField,
  useApi,
  type SelectOption,
} from '@sepehr/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { INTAKE_CATEGORY } from '../../../lib/leads';

const SECTION = 'space-y-3 rounded-lg border border-border bg-surface p-4';

/** A lead entered by hand (doc 05 §1): it goes through the one intake, as every source. */
export function IntakeForm({
  fields,
  cities,
}: {
  fields: readonly SelectOption[];
  cities: readonly SelectOption[];
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; caseId: string | null } | null>(null);
  return (
    <section aria-labelledby="new-lead" className={SECTION}>
      <h2 id="new-lead" className="text-[length:var(--text-lg)] font-bold">
        ثبت سرنخ
      </h2>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const optional = (name: string) => {
            const value = formText(form, name).trim();
            return value === '' ? undefined : value;
          };
          const name = optional('name');
          const nationalId = optional('nationalId');
          const cityCode = optional('city');
          const note = optional('note');
          setBusy(true);
          setError(null);
          setResult(null);
          void unwrap(
            api.POST('/api/v1/lead/intakes', {
              body: {
                mobile: formText(form, 'mobile'),
                treatmentFieldCode: formText(form, 'field'),
                smsConsent: new FormData(form).get('smsConsent') === 'on',
                ...(name ? { name } : {}),
                ...(nationalId ? { nationalId } : {}),
                ...(cityCode ? { cityCode } : {}),
                ...(note ? { note } : {}),
              },
            }),
          )
            .then((r) => {
              setResult({
                text: `${INTAKE_CATEGORY[r.category]}${r.nationalIdConflict ? '؛ کد ملی به شخص دیگری تعلق دارد و ثبت نشد' : ''}.`,
                caseId: r.caseId,
              });
              form.reset();
              router.refresh();
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <TextField
            id="lead-mobile"
            name="mobile"
            label="موبایل"
            type="tel"
            inputMode="tel"
            dir="ltr"
            required
            className="min-w-48"
          />
          <TextField id="lead-name" name="name" label="نام" className="min-w-48 grow" />
          <TextField
            id="lead-national-id"
            name="nationalId"
            label="کد ملی"
            inputMode="numeric"
            dir="ltr"
            className="min-w-48"
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <SelectField id="lead-field" name="field" label="رشته درمان" options={fields} />
          <SelectField
            id="lead-city"
            name="city"
            label="شهر"
            emptyLabel="نامشخص"
            options={cities}
          />
        </div>
        <TextField id="lead-note" name="note" label="یادداشت" />
        <CheckboxField id="lead-consent" name="smsConsent" label="رضایت به پیامک تبلیغاتی" />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ثبت سرنخ
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {result && (
        <Notice tone="success">
          {result.text}{' '}
          {result.caseId && (
            <Link href={`/leads/${result.caseId}`} className="font-medium text-accent underline">
              باز کردن پرونده
            </Link>
          )}
        </Notice>
      )}
    </section>
  );
}

/** The case's next step: start advising (`new` only). */
export function StartAdvising({ caseId }: { caseId: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={() => {
          setBusy(true);
          setError(null);
          void unwrap(
            api.POST('/api/v1/lead/cases/{id}/advising', { params: { path: { id: caseId } } }),
          )
            .then(() => {
              router.refresh();
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        شروع مشاوره
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

/** Closing a case: only with a reason from the list (doc 05 §5). */
export function CancelCase({
  caseId,
  reasons,
}: {
  caseId: string;
  reasons: readonly SelectOption[];
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="close-case" className={SECTION}>
      <h2 id="close-case" className="font-bold">
        بستن پرونده
      </h2>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const note = formText(form, 'note').trim();
          setBusy(true);
          setError(null);
          void unwrap(
            api.POST('/api/v1/lead/cases/{id}/cancel', {
              params: { path: { id: caseId } },
              body: { reasonCode: formText(form, 'reasonCode'), ...(note ? { note } : {}) },
            }),
          )
            .then(() => {
              router.refresh();
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <SelectField id="close-reason" name="reasonCode" label="علت" options={reasons} />
          <TextField id="close-note" name="note" label="یادداشت" className="min-w-64 grow" />
        </div>
        <button type="submit" disabled={busy} className={buttonClass('danger')}>
          بستن پرونده
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}

/** The person asked for no more SMS (doc 05): recorded with a reason. */
export function SmsOptOut({ caseId }: { caseId: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const reason = formText(e.currentTarget, 'reason');
        setBusy(true);
        setError(null);
        void unwrap(
          api.POST('/api/v1/lead/cases/{id}/sms-opt-out', {
            params: { path: { id: caseId } },
            body: { reason },
          }),
        )
          .then(() => {
            router.refresh();
          })
          .catch((err: unknown) => {
            setError(errorMessage(err));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <TextField
        id="opt-out-reason"
        name="reason"
        label="دلیل لغو پیامک"
        required
        className="min-w-64 grow"
      />
      <button type="submit" disabled={busy} className={buttonClass('secondary')}>
        لغو پیامک‌ها
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/**
 * Handing the case to another agent (doc 05 §4; owner 1405/07/24: only the strategy
 * manager, `lead.assign_manually`). The agent is found by username, as on the assignment
 * page; the case keeps its queue, only its assignee changes.
 */
export function HandOffCase({ caseId }: { caseId: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <section aria-labelledby="hand-off" className={SECTION}>
      <h2 id="hand-off" className="font-bold">
        انتقال به کارشناس دیگر
      </h2>
      <p className="text-[length:var(--text-sm)] text-ink-muted">
        صف پرونده عوض نمی‌شود، فقط مسئول آن؛ گزارش هدف و واقعی صف مقصد این انتقال را نمی‌شمارد.
      </p>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const username = formText(form, 'username').trim();
          const reason = formText(form, 'reason');
          setBusy(true);
          setError(null);
          setDone(null);
          void unwrap(
            api.GET('/api/v1/lead/agents/by-username/{username}', {
              params: { path: { username } },
            }),
          )
            .then((agent) =>
              unwrap(
                api.POST('/api/v1/lead/cases/{id}/assignments', {
                  params: { path: { id: caseId } },
                  body: { accountId: agent.id, reason },
                }),
              ).then(() => agent.displayName ?? agent.username),
            )
            .then((name) => {
              setDone(name);
              form.reset();
              router.refresh();
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <TextField id="hand-off-username" name="username" label="نام کاربری کارشناس" dir="ltr" />
          <TextField id="hand-off-reason" name="reason" label="دلیل" className="min-w-64 grow" />
        </div>
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          انتقال
        </button>
      </form>
      {done && <Notice tone="success">پرونده به {done} منتقل شد.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}

const BLOCK_KIND_OPTIONS: readonly SelectOption[] = [
  { value: 'do_not_contact', label: 'دیگر تماس نگیرید' },
  { value: 'abuse', label: 'سوءاستفاده یا مزاحمت' },
];

/**
 * Blocking the person (doc 05 table of intake kinds; `lead.block_person`, the strategy
 * manager): a new lead of theirs is recorded but not assigned, and the manager is told.
 * Blocking and unblocking both with a reason, in the audit.
 */
export function BlockPerson({ personId, blocked }: { personId: string; blocked: boolean }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="block-person" className={SECTION}>
      <h2 id="block-person" className="font-bold">
        {blocked ? 'رفع مسدودی شخص' : 'مسدود کردن شخص'}
      </h2>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const reason = formText(form, 'reason');
          const path = { params: { path: { id: personId } } };
          setBusy(true);
          setError(null);
          void unwrap(
            blocked
              ? api.POST('/api/v1/lead/persons/{id}/unblock', { ...path, body: { reason } })
              : api.POST('/api/v1/lead/persons/{id}/block', {
                  ...path,
                  body: {
                    kind: formText(form, 'kind') as 'abuse' | 'do_not_contact',
                    reason,
                  },
                }),
          )
            .then(() => {
              form.reset();
              router.refresh();
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          {!blocked && (
            <SelectField
              id="block-kind"
              name="kind"
              label="نوع"
              options={BLOCK_KIND_OPTIONS}
              emptyLabel="انتخاب کنید"
            />
          )}
          <TextField
            id="block-reason"
            name="reason"
            label="دلیل"
            required
            className="min-w-64 grow"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className={buttonClass(blocked ? 'primary' : 'danger')}
        >
          {blocked ? 'رفع مسدودی' : 'مسدود کردن'}
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}

const CASE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface PersonMergeRow {
  readonly id: string;
  readonly movedCount: number;
  readonly reason: string;
  readonly at: string;
  readonly reverted: boolean;
}

/**
 * Merging a duplicate into this case's person (doc 05 §9; `lead.merge_persons`, the strategy
 * manager): the other case is named by its address or id, so no person search is needed.
 * Its person's cases come here; two national IDs that differ, or two open cases, are
 * refused by the API. Each merge this person survived can be undone, exactly, once.
 */
export function MergePersons({
  personId,
  merges,
}: {
  personId: string;
  merges: readonly PersonMergeRow[];
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = (work: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    void work()
      .then((message) => {
        setDone(message);
        router.refresh();
      })
      .catch((err: unknown) => {
        // This form's own refusals are plain errors; the API's are read as everywhere else.
        setError(
          err instanceof Error && !(err instanceof ApiError) ? err.message : errorMessage(err),
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <section aria-labelledby="merge-person" className={SECTION}>
      <h2 id="merge-person" className="font-bold">
        ادغام شخص تکراری
      </h2>
      <p className="text-[length:var(--text-sm)] text-ink-muted">
        پرونده‌های شخص دیگر به همین شخص می‌آیند و موبایل‌های او تا تأیید، به پرونده‌های این شخص راه
        ندارند. دو کد ملی متفاوت یا دو پرونده باز ادغام نمی‌شوند.
      </p>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const other = CASE_ID.exec(formText(form, 'other'))?.[0];
          const reason = formText(form, 'reason');
          run(async () => {
            if (!other) throw new Error('نشانی یا شناسه پرونده تکراری را درست وارد کنید.');
            const kase = await unwrap(
              api.GET('/api/v1/lead/cases/{id}', { params: { path: { id: other } } }),
            );
            if (kase.personId === personId) throw new Error('این پرونده مال همین شخص است.');
            const merged = await unwrap(
              api.POST('/api/v1/lead/person-merges', {
                body: { survivorId: personId, mergedId: kase.personId, reason },
              }),
            );
            form.reset();
            return `ادغام شد؛ ${faDigits(String(merged.movedCaseIds.length))} پرونده به این شخص آمد.`;
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <TextField
            id="merge-other"
            name="other"
            label="نشانی یا شناسه پرونده تکراری"
            dir="ltr"
            required
            className="min-w-64 grow"
          />
          <TextField id="merge-reason" name="reason" label="دلیل ادغام" required />
        </div>
        <button type="submit" disabled={busy} className={buttonClass('danger')}>
          ادغام در همین شخص
        </button>
      </form>
      {merges.length > 0 && (
        <ul aria-label="ادغام‌های این شخص" className="space-y-2">
          {merges.map((m) => (
            <li key={m.id} className="flex flex-wrap items-end gap-3 border-t border-border pt-2">
              <span>
                <time dateTime={m.at}>{showInstant(m.at)}</time> · {faDigits(String(m.movedCount))}{' '}
                پرونده · {m.reason}
                {m.reverted && ' · برگشت خورده'}
              </span>
              {!m.reverted && (
                <form
                  className="flex flex-wrap items-end gap-2"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    const reason = formText(e.currentTarget, 'reason');
                    run(async () => {
                      const reverted = await unwrap(
                        api.POST('/api/v1/lead/person-merges/{id}/revert', {
                          params: { path: { id: m.id } },
                          body: { reason },
                        }),
                      );
                      return `ادغام برگشت؛ ${faDigits(String(reverted.restoredCaseIds.length))} پرونده برگشت.`;
                    });
                  }}
                >
                  <TextField id={`revert-${m.id}`} name="reason" label="دلیل برگشت" required />
                  <button type="submit" disabled={busy} className={buttonClass('secondary')}>
                    برگشت ادغام
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {done && <Notice tone="success">{done}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}
