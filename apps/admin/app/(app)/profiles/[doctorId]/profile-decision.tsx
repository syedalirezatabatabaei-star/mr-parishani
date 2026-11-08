'use client';

import { unwrap } from '@sepehr/api-client';
import { buttonClass, errorMessage, formText, Notice, TextField, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** The specialist publishes the version or sends it back, always with a reason (rule 9). */
export function ProfileDecision({ versionId }: { versionId: string }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <section
      aria-labelledby="decision"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id="decision" className="text-[length:var(--text-lg)] font-bold">
        تصمیم
      </h2>
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          const reject = (e.nativeEvent.submitter as HTMLButtonElement | null)?.value === 'reject';
          const call = { params: { path: { id: versionId } }, body: { reason } };
          setBusy(true);
          setError(null);
          void unwrap(
            reject
              ? api.POST('/api/v1/catalog/profile-versions/{id}/reject', call)
              : api.POST('/api/v1/catalog/profile-versions/{id}/approve', call),
          )
            .then(() => {
              setDone(reject ? 'نسخه برای اصلاح برگشت داده شد.' : 'پروفایل منتشر شد.');
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
          id="decision-reason"
          name="reason"
          label="دلیل"
          required
          className="min-w-72 grow"
        />
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={busy}
          className={buttonClass('primary')}
        >
          انتشار
        </button>
        <button
          type="submit"
          name="decision"
          value="reject"
          disabled={busy}
          className={buttonClass('danger')}
        >
          برگشت برای اصلاح
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </section>
  );
}
