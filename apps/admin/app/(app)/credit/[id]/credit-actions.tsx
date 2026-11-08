'use client';

import { unwrap } from '@sepehr/api-client';
import { fromJalali, parseRial, type JalaliDate } from '@sepehr/contracts';
import {
  buttonClass,
  DateField,
  errorMessage,
  formText,
  inputClass,
  MoneyField,
  Notice,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode, type SubmitEvent } from 'react';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      router.refresh();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

/** Rials typed in any digits and separators (owner, 1405/07/11); null if not whole. */
function rialsOf(typed: string): string | null {
  return parseRial(typed)?.toString() ?? null;
}

function ActionError({ error }: { error: string | null }) {
  return error ? <Notice tone="danger">{error}</Notice> : null;
}

// --- documents -----------------------------------------------------------------------

/** A document seen only through a short signed link; every view is logged (doc 04 §7). */
export function ViewDocument({ id, documentId }: { id: string; documentId: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <>
      <button
        type="button"
        disabled={busy}
        className={buttonClass('quiet')}
        onClick={() =>
          void run(async () => {
            const link = await unwrap(
              api.GET('/api/v1/credit/applications/{id}/documents/{documentId}/link', {
                params: { path: { id, documentId } },
              }),
            );
            window.open(link.url, '_blank', 'noopener');
          })
        }
      >
        مشاهده فایل
      </button>
      <ActionError error={error} />
    </>
  );
}

/** Case completion accepts a document, or rejects it with a reason sent to its owner. */
export function DecideDocument({ id, documentId }: { id: string; documentId: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [rejecting, setRejecting] = useState(false);
  const decide = (decision: 'accept' | 'reject', reason?: string) =>
    run(() =>
      unwrap(
        api.POST('/api/v1/credit/applications/{id}/documents/{documentId}/decision', {
          params: { path: { id, documentId } },
          body: decision === 'accept' ? { decision } : { decision, reason: reason ?? '' },
        }),
      ),
    );
  if (rejecting) {
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void decide('reject', formText(e.currentTarget, 'reason'));
        }}
      >
        <TextField id={`reject-${documentId}`} name="reason" label="دلیل رد" required />
        <button type="submit" disabled={busy} className={buttonClass('danger')}>
          رد مدرک
        </button>
        <ActionError error={error} />
      </form>
    );
  }
  return (
    <span className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('secondary')}
        onClick={() => void decide('accept')}
      >
        پذیرش
      </button>
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          setRejecting(true);
        }}
      >
        رد
      </button>
      <ActionError error={error} />
    </span>
  );
}

/** A plain POST on the application with no body, as a button. */
export function PostButton({
  path,
  id,
  label,
  variant = 'primary',
}: {
  path:
    | '/api/v1/credit/applications/{id}/ready-for-review'
    | '/api/v1/credit/applications/{id}/to-decision';
  id: string;
  label: string;
  variant?: 'primary' | 'secondary';
}) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass(variant)}
        onClick={() => void run(() => unwrap(api.POST(path, { params: { path: { id } } })))}
      >
        {label}
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

// --- scoring -------------------------------------------------------------------------

export interface Criterion {
  readonly code: string;
  readonly label: string;
  readonly options: readonly { code: string; label: string; score: number }[];
}

function OptionSelect({
  id,
  criterion,
}: {
  id: string;
  criterion: Criterion | undefined;
}): ReactNode {
  if (!criterion) return null;
  return (
    <SelectField
      id={id}
      name={criterion.code}
      label={criterion.label}
      emptyLabel="انتخاب کنید"
      options={criterion.options.map((o) => ({ value: o.code, label: o.label }))}
    />
  );
}

function TomanField({
  id,
  name,
  label,
  hint,
}: {
  id: string;
  name: string;
  label: string;
  hint: string;
}) {
  // Rials, grouped, with the tomans under them (owner, 1405/07/11).
  return <MoneyField id={id} name={name} label={label} hint={hint} />;
}

/**
 * Raw data, never a band (doc 03 §8-1): the job, the day employment started (the one
 * Jalali date picker, rule 22), amounts in rials; the engine chooses the bands. No
 * medical field exists in the form, as in the API (doc 10 §10 test 12).
 */
export function ScoreForm({
  id,
  subject,
  guarantorId,
  criteria,
  today,
}: {
  id: string;
  subject: 'borrower' | 'guarantor';
  guarantorId?: string;
  criteria: readonly Criterion[];
  today: JalaliDate;
}) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [started, setStarted] = useState<JalaliDate | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const find = (code: string) => criteria.find((c) => c.code === code);
  const key = guarantorId ?? 'borrower';

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => {
      const v = form.get(name);
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    };
    const amounts: Record<string, string> = {};
    const fields =
      subject === 'borrower'
        ? ['obligationsRial', 'newInstallmentRial']
        : ['averageBalanceRial', 'installmentRial'];
    for (const f of fields) {
      const typed = text(f);
      if (typed === undefined) continue;
      const rial = rialsOf(typed);
      if (rial === null) {
        setProblem('مبلغ‌ها را به ریال و به‌صورت عدد کامل بنویسید.');
        return;
      }
      amounts[f] = rial;
    }
    setProblem(null);
    const shared = {
      ...(text('job') ? { job: text('job') } : {}),
      ...(started ? { employmentStartedOn: started } : {}),
    };
    const body =
      subject === 'borrower'
        ? {
            subject: 'borrower' as const,
            raw: {
              ...shared,
              ...(text('coverage') ? { coverage: text('coverage') } : {}),
              ...amounts,
            },
          }
        : {
            subject: 'guarantor' as const,
            guarantorId: guarantorId ?? '',
            raw: {
              ...shared,
              ...(text('debts') ? { debts: text('debts') } : {}),
              ...(text('independence') ? { independence: text('independence') } : {}),
              ...amounts,
            },
          };
    void run(() =>
      unwrap(
        api.POST('/api/v1/credit/applications/{id}/score-sheets', {
          params: { path: { id } },
          body: body as never,
        }),
      ),
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <OptionSelect id={`${key}-job`} criterion={find('job')} />
        <DateField
          mode="single"
          label="شروع اشتغال"
          today={today}
          max={today}
          value={started}
          onChange={setStarted}
          hint="از روی مدرک شغل"
        />
        {subject === 'borrower' ? (
          <>
            <OptionSelect id={`${key}-coverage`} criterion={find('coverage')} />
            <TomanField
              id={`${key}-obligations`}
              name="obligationsRial"
              label="قسط تعهدات قبلی"
              hint="از گردش حساب و استعلام"
            />
            <TomanField
              id={`${key}-installment`}
              name="newInstallmentRial"
              label="قسط تازه"
              hint="از پیش‌نمایش طرح"
            />
          </>
        ) : (
          <>
            <TomanField
              id={`${key}-balance`}
              name="averageBalanceRial"
              label="میانگین مانده حساب"
              hint="از گردش حساب"
            />
            <TomanField
              id={`${key}-installment`}
              name="installmentRial"
              label="قسط مورد ضمانت"
              hint="از پیش‌نمایش طرح"
            />
            <OptionSelect id={`${key}-debts`} criterion={find('debts')} />
            <OptionSelect id={`${key}-independence`} criterion={find('independence')} />
          </>
        )}
      </div>
      {problem && <Notice tone="danger">{problem}</Notice>}
      <ActionError error={error} />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت داده خام و اجرای موتور
      </button>
    </form>
  );
}

// --- decisions -----------------------------------------------------------------------

const OUTCOMES = [
  { value: 'approved', label: 'تأیید' },
  { value: 'conditional', label: 'تأیید شرطی' },
  { value: 'rejected', label: 'رد' },
  { value: 'needs_more_guarantors', label: 'نیاز به ضامن بیشتر' },
] as const;

const lines = (typed: string) =>
  typed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * A decision, always with a reason (doc 03 §8-5). The engine's authority decides who may
 * confirm it; out of the matrix it is an exception for the committee and a second
 * approver (doc 03 §6). The committee's minutes: number, day and who attended.
 */
export function ProposeDecision({
  id,
  committee,
  mayGoOutOfMatrix,
  reasons,
  today,
}: {
  id: string;
  committee: boolean;
  mayGoOutOfMatrix: boolean;
  reasons: readonly { code: string; label: string }[];
  today: JalaliDate;
}) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [outcome, setOutcome] = useState<string>('approved');
  const [outOfMatrix, setOutOfMatrix] = useState(false);
  const [meeting, setMeeting] = useState<JalaliDate | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const needsMinutes = (committee || outOfMatrix) && outcome !== 'needs_more_guarantors';

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const reason = formText(form, 'reason');
    const body: Record<string, unknown> = { outcome, reason };
    if (outcome === 'approved' || outcome === 'conditional') {
      const typed = formText(form, 'amount');
      if (typed) {
        const rial = rialsOf(typed);
        if (rial === null) {
          setProblem('مبلغ مصوب را به ریال و به‌صورت عدد کامل بنویسید.');
          return;
        }
        body['approvedAmountRial'] = rial;
      }
      if (outOfMatrix) body['outOfMatrix'] = true;
    }
    if (outcome === 'conditional') body['conditions'] = lines(formText(form, 'conditions'));
    if (outcome === 'needs_more_guarantors') body['missing'] = lines(formText(form, 'missing'));
    if (outcome === 'rejected') body['reasonCode'] = formText(form, 'reasonCode');
    if (needsMinutes) {
      if (!meeting) {
        setProblem('روز جلسه کمیته را انتخاب کنید.');
        return;
      }
      body['committee'] = {
        minutesNumber: formText(form, 'minutesNumber'),
        meetingAt: fromJalali(meeting, { hour: 12, minute: 0 }).toISOString(),
        attendeeAccountIds: formText(form, 'attendees')
          .split(/[\s,،]+/)
          .filter(Boolean),
      };
    }
    setProblem(null);
    void run(() =>
      unwrap(
        api.POST('/api/v1/credit/applications/{id}/decisions', {
          params: { path: { id } },
          body: body as never,
        }),
      ),
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <SelectField
        id="outcome"
        name="outcome"
        label="تصمیم پیشنهادی"
        defaultValue={outcome}
        onChange={setOutcome}
        options={OUTCOMES.map((o) => ({ value: o.value, label: o.label }))}
      />
      {(outcome === 'approved' || outcome === 'conditional') && (
        <>
          <MoneyField
            id="amount"
            name="amount"
            label="مبلغ مصوب، اختیاری"
            hint="خالی یعنی همه مبلغ وام؛ کاهش مبلغ، سطح و مرجع را دوباره حساب می‌کند."
          />
          {mayGoOutOfMatrix && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={outOfMatrix}
                onChange={(e) => {
                  setOutOfMatrix(e.target.checked);
                }}
              />
              تصمیم خارج از ماتریس (با کمیته و تأییدکننده دوم)
            </label>
          )}
        </>
      )}
      {outcome === 'conditional' && <Lines id="conditions" label="شرط‌ها (هر خط یک شرط)" />}
      {outcome === 'needs_more_guarantors' && <Lines id="missing" label="کمبودها (هر خط یکی)" />}
      {outcome === 'rejected' && (
        <SelectField
          id="reasonCode"
          name="reasonCode"
          label="کد دلیل رد"
          options={reasons.map((r) => ({ value: r.code, label: r.label }))}
        />
      )}
      <Lines id="reason" label="دلیل (الزامی)" />
      {needsMinutes && (
        <fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="font-bold">صورت‌جلسه کمیته</legend>
          <TextField id="minutesNumber" name="minutesNumber" label="شماره صورت‌جلسه" required />
          <DateField
            mode="single"
            label="روز جلسه"
            today={today}
            max={today}
            value={meeting}
            onChange={setMeeting}
          />
          <Lines id="attendees" label="شناسه حساب حاضران (با فاصله یا ویرگول)" ltr />
        </fieldset>
      )}
      {problem && <Notice tone="danger">{problem}</Notice>}
      <ActionError error={error} />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت پیشنهاد
      </button>
    </form>
  );
}

function Lines({ id, label, ltr }: { id: string; label: string; ltr?: boolean }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[length:var(--text-sm)] font-medium">
        {label}
      </label>
      <textarea id={id} name={id} rows={3} dir={ltr ? 'ltr' : undefined} className={inputClass} />
    </div>
  );
}

/** Confirm, refuse or withdraw an open proposal; a committee member votes for a unit. */
export function DecisionActions({
  id,
  decisionId,
  mayConfirm,
  mayVote,
  units,
}: {
  id: string;
  decisionId: string;
  mayConfirm: boolean;
  mayVote: boolean;
  units: readonly { code: string; label: string }[];
}) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const path = { params: { path: { id, decisionId } } };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {mayConfirm && (
          <button
            type="button"
            disabled={busy}
            className={buttonClass('primary')}
            onClick={() =>
              void run(() =>
                unwrap(
                  api.POST('/api/v1/credit/applications/{id}/decisions/{decisionId}/confirm', path),
                ),
              )
            }
          >
            تأیید پیشنهاد
          </button>
        )}
      </div>
      {mayVote && (
        <form
          className="flex flex-wrap items-end gap-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const submitter = (e.nativeEvent as unknown as { submitter?: HTMLButtonElement | null })
              .submitter;
            void run(() =>
              unwrap(
                api.POST('/api/v1/credit/applications/{id}/decisions/{decisionId}/votes', {
                  ...path,
                  body: {
                    unitCode: formText(form, 'unitCode'),
                    vote: submitter?.value === 'object' ? 'object' : 'approve',
                  },
                }),
              ),
            );
          }}
        >
          <SelectField
            id={`unit-${decisionId}`}
            name="unitCode"
            label="رأی از طرف واحد"
            options={units.map((u) => ({ value: u.code, label: u.label }))}
          />
          <button
            type="submit"
            value="approve"
            disabled={busy}
            className={buttonClass('secondary')}
          >
            رأی موافق
          </button>
          <button type="submit" value="object" disabled={busy} className={buttonClass('danger')}>
            رأی مخالف
          </button>
        </form>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          void run(() =>
            unwrap(
              api.POST('/api/v1/credit/applications/{id}/decisions/{decisionId}/close', {
                ...path,
                body: { reason },
              }),
            ),
          );
        }}
      >
        <TextField id={`close-${decisionId}`} name="reason" label="دلیل بستن پیشنهاد" />
        <button type="submit" disabled={busy} className={buttonClass('quiet')}>
          پس گرفتن یا رد پیشنهاد
        </button>
      </form>
      <ActionError error={error} />
    </div>
  );
}
