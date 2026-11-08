'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  SelectField,
  STAFF_TICKET_STATUS,
  TextAreaField,
  TextField,
  TICKET_UNIT,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode, type SubmitEvent } from 'react';

/** Runs one action, then shows the page afresh; its error beside the form. */
function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    void action()
      .then(() => {
        after?.();
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, run };
}

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <h2 className="font-bold text-ink">{title}</h2>
      {children}
    </section>
  );
}

const MOVES = ['in_progress', 'waiting_on_requester', 'resolved'] as const;

/** The ticket's next state (doc 17 §1), with an optional note to the requester. */
export function StatusForm({ id, financial }: { id: string; financial: boolean }) {
  const api = useApi();
  const { busy, error, run } = useAction();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const to = MOVES.find((m) => m === formText(form, 'to'));
    if (!to) return;
    const note = formText(form, 'note').trim();
    run(() =>
      unwrap(
        api.POST('/api/v1/tickets/{id}/status', {
          params: { path: { id } },
          body: { to, ...(note === '' ? {} : { note }) },
        }),
      ),
    );
  };
  return (
    <Box title="وضعیت">
      <form onSubmit={submit} className="space-y-3" aria-label="تغییر وضعیت" noValidate>
        <SelectField
          id="status-to"
          name="to"
          label="وضعیت تازه"
          options={MOVES.filter((m) => !financial || m !== 'resolved').map((m) => ({
            value: m,
            label: STAFF_TICKET_STATUS[m].label,
          }))}
          {...(financial ? { hint: 'شکایت مالی فقط با تعیین تکلیف اختلاف حل‌شده می‌شود.' } : {})}
        />
        <TextField id="status-note" name="note" label="یادداشت برای ثبت‌کننده (اختیاری)" />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ثبت وضعیت
        </button>
      </form>
    </Box>
  );
}

/** Another unit takes it, with a reason (doc 17 §1: «ارجاع بین واحدها با دلیل»). */
export function TransferForm({ id, unit }: { id: string; unit: string }) {
  const api = useApi();
  const { busy, error, run } = useAction();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const body = { unit: formText(form, 'unit'), reason: formText(form, 'reason') };
    run(() =>
      unwrap(api.POST('/api/v1/tickets/{id}/transfer', { params: { path: { id } }, body })),
    );
  };
  return (
    <Box title="ارجاع به واحد دیگر">
      <form onSubmit={submit} className="space-y-3" aria-label="ارجاع" noValidate>
        <SelectField
          id="transfer-unit"
          name="unit"
          label="واحد مقصد"
          options={Object.entries(TICKET_UNIT)
            .filter(([value]) => value !== unit)
            .map(([value, label]) => ({ value, label }))}
        />
        <TextField id="transfer-reason" name="reason" label="دلیل ارجاع" required />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <button type="submit" disabled={busy} className={buttonClass('secondary')}>
          ارجاع
        </button>
      </form>
    </Box>
  );
}

/**
 * Who works it (ticket.assign): oneself, or an agent of the ticket's unit picked by name (the
 * owner's ruling, 7-7: name and unit only, no mobile). The API checks they work the unit.
 */
export function AssignForm({
  id,
  me,
  agents,
}: {
  id: string;
  me: string;
  agents: readonly { accountId: string; name: string }[];
}) {
  const api = useApi();
  const { busy, error, run } = useAction();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const chosen = formText(form, 'accountId');
    const body = { accountId: chosen === '' ? me : chosen, reason: formText(form, 'reason') };
    run(() => unwrap(api.POST('/api/v1/tickets/{id}/assign', { params: { path: { id } }, body })));
  };
  return (
    <Box title="سپردن به کارشناس">
      <form onSubmit={submit} className="space-y-3" aria-label="سپردن" noValidate>
        <SelectField
          id="assign-account"
          name="accountId"
          label="کارشناس"
          emptyLabel="به من اختصاص بده"
          options={agents
            .filter((a) => a.accountId !== me)
            .map((a) => ({ value: a.accountId, label: a.name }))}
        />
        <TextField id="assign-reason" name="reason" label="دلیل" required />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <button type="submit" disabled={busy} className={buttonClass('secondary')}>
          سپردن
        </button>
      </form>
    </Box>
  );
}

/** Marks a message as telling of the treatment, after it was written (task 7-2). */
export function FlagMessage({ id, messageId }: { id: string; messageId: string }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  if (!open) {
    return (
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          setOpen(true);
        }}
      >
        علامت «حاوی اطلاعات درمان»
      </button>
    );
  }
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = formText(e.currentTarget, 'reason');
    run(
      () =>
        unwrap(
          api.POST('/api/v1/tickets/{id}/messages/{messageId}/flag', {
            params: { path: { id, messageId } },
            body: { reason },
          }),
        ),
      () => {
        setOpen(false);
      },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" noValidate>
      <TextField id={`flag-${messageId}`} name="reason" label="دلیل" required />
      <button type="submit" disabled={busy} className={buttonClass('secondary')}>
        علامت
      </button>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </form>
  );
}

/**
 * A financial complaint's dispute decided (doc 17 §1; task 5-2): accepted or rejected with a
 * note, by settlement.resolve_dispute only, and never by who opened it. The complaint is
 * resolved by 7-2's consumer once decided; an accepted payable is posted after (5-2b).
 */
export function DisputeDecision({ disputeId, status }: { disputeId: string; status: string }) {
  const api = useApi();
  const { busy, error, run } = useAction();
  const form = useRef<HTMLFormElement>(null);
  const params = { path: { id: disputeId } };
  if (status === 'accepted_pending_posting') {
    return (
      <div className="space-y-2">
        <p>پذیرفته شد؛ اصلاح دفتر کل هنوز ثبت نشده است.</p>
        <button
          type="button"
          disabled={busy}
          className={buttonClass('primary')}
          onClick={() => {
            run(() => unwrap(api.POST('/api/v1/settlement/disputes/{id}/post', { params })));
          }}
        >
          ثبت اصلاح
        </button>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    );
  }
  if (status !== 'open') return null;
  const decide = (outcome: 'accepted' | 'rejected') => {
    const note = form.current ? formText(form.current, 'note') : '';
    run(() =>
      unwrap(
        api.POST('/api/v1/settlement/disputes/{id}/resolve', { params, body: { outcome, note } }),
      ),
    );
  };
  return (
    <form
      ref={form}
      onSubmit={(e) => {
        e.preventDefault();
      }}
      className="space-y-3"
      aria-label="تعیین تکلیف"
      noValidate
    >
      <TextAreaField id="dispute-note" name="note" label="یادداشت تصمیم" required rows={3} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={buttonClass('primary')}
          onClick={() => {
            decide('accepted');
          }}
        >
          پذیرش اعتراض
        </button>
        <button
          type="button"
          disabled={busy}
          className={buttonClass('danger')}
          onClick={() => {
            decide('rejected');
          }}
        >
          رد اعتراض
        </button>
      </div>
    </form>
  );
}
