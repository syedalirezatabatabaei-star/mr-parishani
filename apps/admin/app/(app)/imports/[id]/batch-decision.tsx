'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Commit a previewed batch, or cancel one (doc 05 §8: until its records are acted on). */
export function BatchDecision({ batchId, canCommit }: { batchId: string; canCommit: boolean }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <section
      aria-labelledby="batch-decision"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id="batch-decision" className="text-[length:var(--text-lg)] font-bold">
        تصمیم
      </h2>
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          const cancel = (e.nativeEvent.submitter as HTMLButtonElement | null)?.value === 'cancel';
          const call = { params: { path: { id: batchId } }, body: { reason } };
          setBusy(true);
          setError(null);
          void unwrap(
            cancel
              ? api.POST('/api/v1/catalog/imports/{id}/cancel', call)
              : api.POST('/api/v1/catalog/imports/{id}/commit', call),
          )
            .then(() => {
              setDone(cancel ? 'دسته لغو شد.' : 'دسته ثبت شد و پردازش می‌شود.');
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
          id="batch-reason"
          name="reason"
          label="دلیل"
          required
          className="min-w-72 grow"
        />
        {canCommit && (
          <button
            type="submit"
            name="decision"
            value="commit"
            disabled={busy}
            className={buttonClass('primary')}
          >
            ثبت دسته
          </button>
        )}
        <button
          type="submit"
          name="decision"
          value="cancel"
          disabled={busy}
          className={buttonClass('danger')}
        >
          لغو دسته
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </section>
  );
}
