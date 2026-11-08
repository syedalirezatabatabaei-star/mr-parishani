'use client';

import { unwrap } from '@sepehr/api-client';
import { normalizeDigits } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  faDigits,
  formText,
  Notice,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface EditableShare {
  readonly accountId: string;
  readonly name: string | null;
  readonly percent: number;
}

const SECTION = 'space-y-3 rounded-lg border border-border bg-surface p-4';

/**
 * A queue's shares as a new version (doc 05 §6): whole percents summing to 100, an agent added
 * by username (an active staff account only), a reason. The API checks the sum and the
 * agents again; every version is audited and its counting starts over.
 */
export function SharesEditor({
  queueCode,
  cityCode,
  treatmentFieldCode,
  initial,
}: {
  queueCode: string;
  cityCode: string | null;
  treatmentFieldCode: string | null;
  initial: readonly EditableShare[];
}) {
  const api = useApi();
  const router = useRouter();
  const [rows, setRows] = useState<readonly EditableShare[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const total = rows.reduce((s, r) => s + r.percent, 0);

  const run = (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    void work()
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section aria-labelledby="shares-edit" className={SECTION}>
      <h2 id="shares-edit" className="text-[length:var(--text-lg)] font-bold">
        سهم‌های تازه
      </h2>
      <form
        className="flex flex-wrap items-end gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const username = formText(e.currentTarget, 'username').trim();
          run(async () => {
            const agent = await unwrap(
              api.GET('/api/v1/lead/agents/by-username/{username}', {
                params: { path: { username } },
              }),
            );
            if (rows.some((r) => r.accountId === agent.id)) return;
            setRows([
              ...rows,
              { accountId: agent.id, name: agent.displayName ?? agent.username, percent: 0 },
            ]);
          });
        }}
      >
        <TextField
          id="agent-username"
          name="username"
          label="نام کاربری کارشناس"
          dir="ltr"
          required
          className="min-w-56"
        />
        <button type="submit" disabled={busy} className={buttonClass('secondary')}>
          افزودن کارشناس
        </button>
      </form>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          if (total !== 100) {
            setError('جمع سهم‌ها باید ۱۰۰ باشد.');
            return;
          }
          run(async () => {
            await unwrap(
              api.PUT('/api/v1/lead/assignment/shares', {
                body: {
                  queueCode,
                  ...(cityCode ? { cityCode } : {}),
                  ...(treatmentFieldCode ? { treatmentFieldCode } : {}),
                  shares: rows.map((r) => ({ accountId: r.accountId, percent: r.percent })),
                  reason,
                },
              }),
            );
            setDone('نسخه تازه سهم‌ها ثبت شد.');
            router.refresh();
          });
        }}
      >
        <ul className="space-y-2" aria-label="سهم کارشناسان">
          {rows.map((r) => (
            <li key={r.accountId} className="flex flex-wrap items-end gap-3">
              <span className="min-w-48 font-medium">{r.name ?? '—'}</span>
              <div className="space-y-1">
                <label
                  htmlFor={`percent-${r.accountId}`}
                  className="block text-[length:var(--text-sm)]"
                >
                  درصد {r.name ?? ''}
                </label>
                <input
                  id={`percent-${r.accountId}`}
                  inputMode="numeric"
                  dir="ltr"
                  className="block min-h-10 w-24 rounded-md border border-border-strong bg-surface px-3"
                  value={faDigits(String(r.percent))}
                  onChange={(e) => {
                    const n = Number(normalizeDigits(e.target.value).replace(/\D/g, '') || '0');
                    setRows(
                      rows.map((x) =>
                        x.accountId === r.accountId ? { ...x, percent: Math.min(100, n) } : x,
                      ),
                    );
                  }}
                />
              </div>
              <button
                type="button"
                className={buttonClass('quiet', 'min-h-9 px-2')}
                onClick={() => {
                  setRows(rows.filter((x) => x.accountId !== r.accountId));
                }}
              >
                برداشتن
              </button>
            </li>
          ))}
        </ul>
        <p aria-live="polite" className={total === 100 ? 'text-success' : 'text-danger'}>
          جمع: {faDigits(String(total))} از ۱۰۰
        </p>
        <TextField id="shares-reason" name="reason" label="دلیل" required />
        <button
          type="submit"
          disabled={busy || rows.length === 0}
          className={buttonClass('primary')}
        >
          ثبت سهم‌ها
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </section>
  );
}

/**
 * An agent's presence and open-case cap, each with a reason (doc 05 §6). The forms start at
 * the values in force, and the page is read again after a change.
 */
export function AgentSettings({
  accountId,
  name,
  presence,
  maxOpenCases: capInForce,
}: {
  accountId: string;
  name: string;
  presence: 'present' | 'on_leave' | 'absent';
  maxOpenCases: number | null;
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    void work()
      .then(() => {
        setDone(message);
        router.refresh();
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={`حضور ${name}`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const status = formText(form, 'status') as 'present' | 'on_leave' | 'absent';
          run(
            () =>
              unwrap(
                api.PUT('/api/v1/lead/agents/{accountId}/presence', {
                  params: { path: { accountId } },
                  body: { status, reason: formText(form, 'reason') },
                }),
              ),
            'حضور ثبت شد.',
          );
        }}
      >
        <SelectField
          id={`presence-${accountId}`}
          name="status"
          label="حضور"
          defaultValue={presence}
          options={[
            { value: 'present', label: 'حاضر' },
            { value: 'on_leave', label: 'مرخصی' },
            { value: 'absent', label: 'غایب' },
          ]}
        />
        <TextField id={`presence-reason-${accountId}`} name="reason" label="دلیل حضور" required />
        <button type="submit" disabled={busy} className={buttonClass('secondary', 'min-h-9 px-3')}>
          ثبت حضور
        </button>
      </form>
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={`سقف ${name}`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const typed = normalizeDigits(formText(form, 'cap')).trim();
          const maxOpenCases = typed === '' ? null : Number(typed);
          if (maxOpenCases !== null && (!Number.isInteger(maxOpenCases) || maxOpenCases < 0)) {
            setError('سقف را عدد صحیح وارد کنید، یا خالی بگذارید برای بی‌سقف.');
            return;
          }
          run(
            () =>
              unwrap(
                api.PUT('/api/v1/lead/agents/{accountId}/cap', {
                  params: { path: { accountId } },
                  body: { maxOpenCases, reason: formText(form, 'reason') },
                }),
              ),
            'سقف ثبت شد.',
          );
        }}
      >
        <TextField
          id={`cap-${accountId}`}
          name="cap"
          label="سقف پرونده باز"
          hint="خالی: بی‌سقف"
          inputMode="numeric"
          dir="ltr"
          defaultValue={capInForce === null ? '' : String(capInForce)}
        />
        <TextField id={`cap-reason-${accountId}`} name="reason" label="دلیل سقف" required />
        <button type="submit" disabled={busy} className={buttonClass('secondary', 'min-h-9 px-3')}>
          ثبت سقف
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </div>
  );
}
