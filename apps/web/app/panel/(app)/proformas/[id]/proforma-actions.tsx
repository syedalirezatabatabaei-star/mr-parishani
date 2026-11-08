'use client';

import { unwrap } from '@sepehr/api-client';
import type { ProformaStatus } from '@sepehr/contracts';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { ProformaEditor, type DraftLine, type PricedService } from '../proforma-editor';

/**
 * What the doctor does with one proforma: issue or discard a draft (with a reason), or
 * correct an issued, disputed or expired one as a new version (task 3-4 decision).
 */
export function ProformaActions({
  id,
  status,
  revisable,
  services,
  lines,
}: {
  id: string;
  status: ProformaStatus;
  revisable: boolean;
  services: readonly PricedService[];
  lines: readonly DraftLine[];
}) {
  const api = useApi();
  const router = useRouter();
  const [mode, setMode] = useState<'idle' | 'discard' | 'revise'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode('idle');
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'revise') {
    return (
      <section className="space-y-3" aria-labelledby="revise-title">
        <h2 id="revise-title" className="text-[length:var(--text-lg)] font-bold">
          نسخه تازه
        </h2>
        <ProformaEditor
          target={{ kind: 'revise', proformaId: id }}
          services={services}
          initial={lines}
        />
        <button
          type="button"
          className={buttonClass('quiet')}
          onClick={() => {
            setMode('idle');
          }}
        >
          انصراف
        </button>
      </section>
    );
  }
  if (mode === 'discard') {
    const submit = (e: SubmitEvent<HTMLFormElement>) => {
      e.preventDefault();
      const reason = formText(e.currentTarget, 'reason');
      void run(() =>
        unwrap(
          api.POST('/api/v1/proformas/{id}/discard', {
            params: { path: { id } },
            body: { reason },
          }),
        ),
      );
    };
    return (
      <form onSubmit={submit} className="space-y-2" noValidate>
        <TextField
          id="discard-reason"
          name="reason"
          label="دلیل دور انداختن"
          required
          error={error}
        />
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className={buttonClass('danger')}>
            دور انداختن پیش‌نویس
          </button>
          <button
            type="button"
            className={buttonClass('quiet')}
            onClick={() => {
              setMode('idle');
            }}
          >
            انصراف
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {status === 'draft' && (
        <>
          <button
            type="button"
            disabled={busy}
            className={buttonClass('primary')}
            onClick={() =>
              void run(() =>
                unwrap(api.POST('/api/v1/proformas/{id}/issue', { params: { path: { id } } })),
              )
            }
          >
            صدور برای بیمار
          </button>
          <button
            type="button"
            className={buttonClass('secondary')}
            onClick={() => {
              setMode('discard');
            }}
          >
            دور انداختن
          </button>
        </>
      )}
      {revisable && (
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => {
            setMode('revise');
          }}
        >
          اصلاح با نسخه تازه
        </button>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
