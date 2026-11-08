'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  faDigits,
  FILE_KINDS,
  FileDropzone,
  formText,
  Notice,
  SelectField,
  StatusBadge,
  type StatusTone,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

type Role = 'borrower' | 'guarantor';

function useAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
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

/** The patient or borrower sends a draft on to case completion. */
export function SubmitApplication({ id }: { id: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy}
        className={buttonClass('primary')}
        onClick={() =>
          void run(() =>
            unwrap(
              api.POST('/api/v1/me/credit-applications/{id}/submit', { params: { path: { id } } }),
            ),
          )
        }
      >
        ارسال درخواست برای بررسی
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

/**
 * Consent to the credit check, by the person themselves with a code sent to their own
 * mobile (doc 03 §8-6). Asked separately of the borrower and of each guarantor.
 */
export function ConsentForm({ id, role, text }: { id: string; role: Role; text: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  if (done) return <Notice tone="success">رضایت شما ثبت شد.</Notice>;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const code = formText(e.currentTarget, 'code');
    void run(
      () =>
        unwrap(
          api.POST('/api/v1/me/credit-applications/{id}/consent', {
            params: { path: { id } },
            body: { role, code },
          }),
        ),
      () => {
        setDone(true);
      },
    );
  };
  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-surface p-4"
      aria-labelledby={`consent-${role}`}
    >
      <h2 id={`consent-${role}`} className="font-bold">
        رضایت به بررسی اطلاعات اعتباری
      </h2>
      <p className="text-[length:var(--text-sm)]">{text}</p>
      {!sent ? (
        <button
          type="button"
          disabled={busy}
          className={buttonClass('secondary')}
          onClick={() =>
            void run(
              () =>
                unwrap(
                  api.POST('/api/v1/me/credit-applications/{id}/consent/request', {
                    params: { path: { id } },
                    body: { role },
                  }),
                ),
              () => {
                setSent(true);
              },
            )
          }
        >
          ارسال کد تأیید به موبایل من
        </button>
      ) : (
        <form onSubmit={submit} className="space-y-2" noValidate>
          <TextField
            id={`consent-code-${role}`}
            name="code"
            label="کد پیامک‌شده"
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            figures
            required
          />
          <button type="submit" disabled={busy} className={buttonClass('primary')}>
            موافقم و رضایت می‌دهم
          </button>
        </form>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}

export interface ChecklistItem {
  readonly itemCode: string;
  readonly title: string;
  readonly required: boolean;
  readonly document: { status: string; reason: string | null } | null;
}

const DOC_STATUS: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  submitted: { label: 'در انتظار بررسی', tone: 'info' },
  accepted: { label: 'پذیرفته شد', tone: 'success' },
  rejected: { label: 'رد شد', tone: 'danger' },
};

/**
 * One person's documents (doc 10 §4): each item, its state, why a rejected one was refused,
 * and an upload (PDF, JPEG or PNG; the API checks the real type and scans it).
 */
export function DocumentList({
  id,
  role,
  items,
  canUpload,
}: {
  id: string;
  role: Role;
  items: readonly ChecklistItem[];
  canUpload: boolean;
}) {
  return (
    <ul className="space-y-2" aria-label="مدارک">
      {items.map((item) => {
        const state = item.document ? DOC_STATUS[item.document.status] : null;
        return (
          <li key={item.itemCode} className="space-y-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>
                {item.title}
                {item.required ? '' : ' (اختیاری)'}
              </p>
              {state ? (
                <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
              ) : (
                <StatusBadge tone="warning">بارگذاری نشده</StatusBadge>
              )}
            </div>
            {item.document?.status === 'rejected' && item.document.reason && (
              <p className="text-[length:var(--text-sm)] text-danger">
                دلیل: {item.document.reason}
              </p>
            )}
            {canUpload && item.document?.status !== 'accepted' && (
              <UploadForm id={id} role={role} itemCode={item.itemCode} title={item.title} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function UploadForm({
  id,
  role,
  itemCode,
  title,
}: {
  id: string;
  role: Role;
  itemCode: string;
  title: string;
}) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [hasFile, setHasFile] = useState(false);
  const inputId = `file-${role}-${itemCode}`;
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = new FormData(e.currentTarget).get('file');
    if (!(file instanceof File) || file.size === 0) return;
    void run(() =>
      unwrap(
        api.POST('/api/v1/me/credit-applications/{id}/documents', {
          params: { path: { id } },
          body: { role, itemCode },
          bodySerializer: (body) => {
            const form = new FormData();
            form.append('role', body.role);
            form.append('itemCode', body.itemCode);
            form.append('file', file, file.name);
            return form;
          },
        }),
      ),
    );
  };
  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <FileDropzone
        id={inputId}
        name="file"
        label={`فایل ${title}`}
        kinds={[FILE_KINDS.jpg, FILE_KINDS.png, FILE_KINDS.pdf]}
        // The credit document policy's limit (credit.document_policy, 10 MB); the server holds it.
        maxBytes={10 * 1024 * 1024}
        required
        busy={busy}
        onFileChange={(f) => {
          setHasFile(f !== null);
        }}
      />
      <button type="submit" disabled={busy || !hasFile} className={buttonClass('secondary')}>
        بارگذاری
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/** The patient or borrower introduces a guarantor by mobile (after the borrower's grade). */
export function InviteGuarantor({ id }: { id: string }) {
  const api = useApi();
  const { error, busy, run } = useAction();
  const [done, setDone] = useState(false);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const mobile = formText(e.currentTarget, 'mobile');
    void run(
      () =>
        unwrap(
          api.POST('/api/v1/me/credit-applications/{id}/guarantors', {
            params: { path: { id } },
            body: { mobile },
          }),
        ),
      () => {
        setDone(true);
      },
    );
  };
  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <TextField
        id="guarantor-mobile"
        name="mobile"
        type="tel"
        inputMode="tel"
        dir="ltr"
        figures
        label="موبایل ضامن"
        hint="به ضامن پیامکی با مبلغ تعهدش فرستاده می‌شود؛ جزئیات درمان گفته نمی‌شود."
        required
      />
      <button type="submit" disabled={busy} className={buttonClass('secondary')}>
        معرفی ضامن
      </button>
      {done && <Notice tone="success">ضامن معرفی شد.</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}

/** A large shortfall: a new loan for what the approval left uncovered (doc 10 §7). */
export function ShortfallForm({
  id,
  planCode,
  counts,
}: {
  id: string;
  planCode: string;
  counts: readonly number[];
}) {
  const api = useApi();
  const router = useRouter();
  const { error, busy, run } = useAction();
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const count = Number(formText(e.currentTarget, 'count'));
    void run(async () => {
      const made = await unwrap(
        api.POST('/api/v1/me/credit-applications/{id}/shortfall-application', {
          params: { path: { id } },
          body: { planCode, installmentCount: count },
        }),
      );
      router.push(`/me/credit/${made.id}`);
    });
  };
  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <SelectField
        id="shortfall-count"
        name="count"
        label="تعداد اقساط وام دوم"
        defaultValue={String(counts[0] ?? '')}
        options={counts.map((c) => ({ value: String(c), label: `${faDigits(c)} قسط` }))}
      />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        درخواست وام برای مابقی
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
