'use client';

import { unwrap } from '@sepehr/api-client';
import type { CenterStatus } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  StatusBadge,
  TextField,
  useApi,
  type ButtonVariant,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await work();
      setDone(success);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, done, run };
}

const DOC = {
  received: { label: 'دریافت‌شده', tone: 'info' },
  verified: { label: 'تأییدشده', tone: 'success' },
  incomplete: { label: 'ناقص', tone: 'danger' },
} as const;

/** A checklist document: the reviewer marks it verified or incomplete. */
export function DocumentStatus({
  centerId,
  code,
  status,
  canEdit,
}: {
  centerId: string;
  code: string;
  status: 'received' | 'verified' | 'incomplete' | null;
  canEdit: boolean;
}) {
  const api = useApi();
  const { busy, error, run } = useAction();
  const set = (next: 'verified' | 'incomplete') =>
    void run(
      () =>
        unwrap(
          api.PUT('/api/v1/catalog/centers/{id}/documents/{code}', {
            params: { path: { id: centerId, code } },
            body: { status: next },
          }),
        ),
      'ثبت شد.',
    );
  return (
    <span className="flex flex-wrap items-center gap-2">
      {status ? (
        <StatusBadge tone={DOC[status].tone}>{DOC[status].label}</StatusBadge>
      ) : (
        <StatusBadge tone="neutral">ارسال‌نشده</StatusBadge>
      )}
      {canEdit && status !== 'verified' && (
        <button
          type="button"
          disabled={busy}
          className={buttonClass('secondary', 'min-h-9 px-3')}
          onClick={() => {
            set('verified');
          }}
        >
          تأیید مدرک
        </button>
      )}
      {canEdit && status !== 'incomplete' && (
        <button
          type="button"
          disabled={busy}
          className={buttonClass('quiet', 'min-h-9 px-3')}
          onClick={() => {
            set('incomplete');
          }}
        >
          ناقص
        </button>
      )}
      {error && (
        <span role="alert" className="text-[length:var(--text-xs)] text-danger">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * A second person approves or rejects a request (activation, Sheba change). Mounted for every
 * request, the form only while it is open: once decided, the page is read again and the request
 * is no longer open, and the outcome must still be said (RESUME f1).
 */
export function RequestDecision({ requestId, open }: { requestId: string; open: boolean }) {
  const api = useApi();
  const { busy, error, done, run } = useAction();
  if (!open && !done) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      {open && (
        <form
          className="flex flex-wrap items-end gap-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const note = formText(e.currentTarget, 'note').trim();
            const decision = (e.nativeEvent.submitter as HTMLButtonElement | null)?.value;
            const body = note ? { note } : {};
            void run(
              () =>
                decision === 'reject'
                  ? unwrap(
                      api.POST('/api/v1/catalog/requests/{id}/reject', {
                        params: { path: { id: requestId } },
                        body,
                      }),
                    )
                  : unwrap(
                      api.POST('/api/v1/catalog/requests/{id}/approve', {
                        params: { path: { id: requestId } },
                        body,
                      }),
                    ),
              decision === 'reject' ? 'درخواست رد شد.' : 'درخواست تأیید شد.',
            );
          }}
        >
          <TextField id={`note-${requestId}`} name="note" label="یادداشت (اختیاری)" />
          <button
            type="submit"
            name="decision"
            value="approve"
            disabled={busy}
            className={buttonClass('primary')}
          >
            تأیید درخواست
          </button>
          <button
            type="submit"
            name="decision"
            value="reject"
            disabled={busy}
            className={buttonClass('danger')}
          >
            رد درخواست
          </button>
        </form>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </div>
  );
}

type Transition = 'needs-fix' | 'activation-requests' | 'suspend' | 'terminate';

const TRANSITIONS: Readonly<
  Record<Transition, { label: string; variant: ButtonVariant; done: string }>
> = {
  'needs-fix': {
    label: 'بازگشت برای اصلاح',
    variant: 'secondary',
    done: 'برای اصلاح برگشت داده شد.',
  },
  'activation-requests': {
    label: 'پیشنهاد فعال‌سازی',
    variant: 'primary',
    done: 'پیشنهاد ثبت شد؛ نفر دوم باید تأیید کند.',
  },
  suspend: { label: 'تعلیق', variant: 'danger', done: 'مرکز تعلیق شد.' },
  terminate: { label: 'پایان همکاری', variant: 'danger', done: 'همکاری پایان یافت.' },
};

/** What the reviewer may do with the center now; each with a reason (rule 9). */
export function CenterActions({
  centerId,
  status,
  canReview,
  canSuspend,
  hasOpenActivation,
}: {
  centerId: string;
  status: CenterStatus;
  canReview: boolean;
  canSuspend: boolean;
  hasOpenActivation: boolean;
}) {
  const api = useApi();
  const { busy, error, done, run } = useAction();
  const [open, setOpen] = useState<Transition | null>(null);
  const offered: Transition[] = [];
  if (canReview && status === 'under_review') offered.push('needs-fix');
  if (canReview && !hasOpenActivation && (status === 'under_review' || status === 'suspended')) {
    offered.push('activation-requests');
  }
  if (canSuspend && status === 'active') offered.push('suspend');
  if (canSuspend && (status === 'active' || status === 'suspended')) offered.push('terminate');
  if (offered.length === 0) return null;

  return (
    <section
      aria-labelledby="next-step"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id="next-step" className="text-[length:var(--text-lg)] font-bold">
        گام بعد
      </h2>
      {open ? (
        <form
          className="flex flex-wrap items-end gap-2"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const reason = formText(e.currentTarget, 'reason');
            const path = { params: { path: { id: centerId } }, body: { reason } };
            void run(
              () =>
                open === 'needs-fix'
                  ? unwrap(api.POST('/api/v1/catalog/centers/{id}/needs-fix', path))
                  : open === 'activation-requests'
                    ? unwrap(api.POST('/api/v1/catalog/centers/{id}/activation-requests', path))
                    : open === 'suspend'
                      ? unwrap(api.POST('/api/v1/catalog/centers/{id}/suspend', path))
                      : unwrap(api.POST('/api/v1/catalog/centers/{id}/terminate', path)),
              TRANSITIONS[open].done,
            ).then(() => {
              setOpen(null);
            });
          }}
        >
          <TextField id="transition-reason" name="reason" label="دلیل" required />
          <button type="submit" disabled={busy} className={buttonClass(TRANSITIONS[open].variant)}>
            {TRANSITIONS[open].label}
          </button>
          <button
            type="button"
            className={buttonClass('quiet')}
            onClick={() => {
              setOpen(null);
            }}
          >
            انصراف
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {offered.map((t) => (
            <button
              key={t}
              type="button"
              className={buttonClass(TRANSITIONS[t].variant)}
              onClick={() => {
                setOpen(t);
              }}
            >
              {TRANSITIONS[t].label}
            </button>
          ))}
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </section>
  );
}
