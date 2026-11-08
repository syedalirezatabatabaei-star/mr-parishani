'use client';

import { unwrap } from '@sepehr/api-client';
import type { AppointmentStatus } from '@sepehr/contracts';
import { buttonClass, errorMessage, formText, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

type Action = 'confirm' | 'reject' | 'check-in' | 'examined' | 'no-show' | 'cancel';

interface Spec {
  readonly label: string;
  readonly variant: 'primary' | 'secondary' | 'danger';
  /** What the form asks for first, if anything. */
  readonly input?: { readonly name: 'reason' | 'code'; readonly label: string };
}

const ACTIONS: Readonly<Record<Action, Spec>> = {
  confirm: { label: 'تأیید', variant: 'primary' },
  reject: { label: 'رد', variant: 'danger', input: { name: 'reason', label: 'دلیل رد' } },
  'check-in': {
    label: 'پذیرش',
    variant: 'primary',
    input: { name: 'code', label: 'کد پذیرش بیمار' },
  },
  examined: { label: 'معاینه شد', variant: 'secondary' },
  'no-show': {
    label: 'عدم حضور',
    variant: 'secondary',
    input: { name: 'reason', label: 'توضیح عدم حضور' },
  },
  cancel: { label: 'لغو', variant: 'danger', input: { name: 'reason', label: 'دلیل لغو' } },
};

/** What the center can do with an appointment in each status (doc 08 §7). */
const BY_STATUS: Partial<Record<AppointmentStatus, readonly Action[]>> = {
  requested: ['confirm', 'reject'],
  confirmed: ['check-in', 'no-show', 'cancel'],
  checked_in: ['examined'],
};

/**
 * The center's actions on one appointment. The API decides (state machine, rule 8; scope,
 * rule 12): a refused move is said plainly, and the list is read again either way.
 */
export function StaffActions({ id, status }: { id: string; status: AppointmentStatus }) {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actions = BY_STATUS[status] ?? [];
  if (actions.length === 0) return null;

  const run = async (action: Action, value: string) => {
    setBusy(true);
    setError(null);
    const path = { params: { path: { id } } };
    try {
      if (action === 'confirm') {
        await unwrap(
          api.POST('/api/v1/booking/appointments/{id}/respond', {
            ...path,
            body: { decision: 'confirm' },
          }),
        );
      } else if (action === 'reject') {
        await unwrap(
          api.POST('/api/v1/booking/appointments/{id}/respond', {
            ...path,
            body: { decision: 'reject', reason: value },
          }),
        );
      } else if (action === 'check-in') {
        await unwrap(
          api.POST('/api/v1/booking/appointments/{id}/check-in', {
            ...path,
            body: { code: value },
          }),
        );
      } else if (action === 'examined') {
        await unwrap(api.POST('/api/v1/booking/appointments/{id}/examined', path));
      } else if (action === 'no-show') {
        await unwrap(
          api.POST('/api/v1/booking/appointments/{id}/no-show', {
            ...path,
            body: { reason: value },
          }),
        );
      } else {
        await unwrap(
          api.POST('/api/v1/booking/appointments/{id}/cancel', {
            ...path,
            body: { reason: value },
          }),
        );
      }
      setOpen(null);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const spec = open ? ACTIONS[open] : null;
  if (open && spec?.input) {
    const input = spec.input;
    return (
      <form
        className="flex min-w-56 flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
          e.preventDefault();
          void run(open, formText(e.currentTarget, input.name));
        }}
      >
        <TextField
          id={`${input.name}-${id}`}
          name={input.name}
          label={input.label}
          required
          error={error}
          {...(input.name === 'code'
            ? {
                inputMode: 'numeric' as const,
                dir: 'ltr' as const,
                figures: true,
                autoComplete: 'off',
              }
            : {})}
        />
        <button type="submit" disabled={busy} className={buttonClass(spec.variant)}>
          {spec.label}
        </button>
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setOpen(null);
            setError(null);
          }}
        >
          انصراف
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          disabled={busy}
          className={buttonClass(ACTIONS[action].variant, 'min-h-9 px-3')}
          onClick={() => {
            if (ACTIONS[action].input) setOpen(action);
            else void run(action, '');
          }}
        >
          {ACTIONS[action].label}
        </button>
      ))}
      {error && (
        <p role="alert" className="w-full text-[length:var(--text-xs)] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
