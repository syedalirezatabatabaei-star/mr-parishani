'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

/** ADR-050: «the split of wage and materials was checked», once, with a note. */
export function ReviewCostSplit({ applicationId }: { applicationId: string }) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const note = formText(e.currentTarget, 'note').trim();
    setBusy(true);
    setError(null);
    void unwrap(
      api.POST('/api/v1/credit/applications/{id}/cost-split-review', {
        params: { path: { id: applicationId } },
        body: { note },
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
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="بررسی تفکیک" noValidate>
      <TextField
        id={`cost-split-${applicationId}-note`}
        name="note"
        label="یادداشت بررسی"
        required
      />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        تفکیک بررسی شد
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
