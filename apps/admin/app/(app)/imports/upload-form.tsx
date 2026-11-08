'use client';

import { unwrap } from '@sepehr/api-client';
import { BULK_IMPORT_LIMITS } from '@sepehr/contracts';
import { buttonClass, errorMessage, FILE_KINDS, FileDropzone, Notice, useApi } from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';

/**
 * The template, and a filled file uploaded for its preview (ADR-030): the API scans it,
 * reads it in memory and keeps only the checked rows; then the batch page shows them.
 */
export function UploadForm() {
  const api = useApi();
  const router = useRouter();
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      aria-labelledby="upload"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id="upload" className="text-[length:var(--text-lg)] font-bold">
        بارگذاری فایل
      </h2>
      <p className="text-[length:var(--text-sm)]">
        <a href="/api/v1/catalog/imports/template" download className="text-accent underline">
          دریافت فایل الگو (xlsx)
        </a>
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const file = new FormData(e.currentTarget).get('file');
          if (!(file instanceof File) || file.size === 0) {
            setError('فایل را انتخاب کنید.');
            return;
          }
          const form = new FormData();
          form.append('file', file);
          setBusy(true);
          setError(null);
          void unwrap(
            api.POST('/api/v1/catalog/imports', {
              // multipart/form-data: the browser sets the boundary itself.
              body: form as never,
              bodySerializer: (body: unknown) => body as FormData,
            }),
          )
            .then((preview) => {
              router.push(`/imports/${preview.batchId}`);
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
              setBusy(false);
            });
        }}
      >
        <FileDropzone
          id={inputId}
          name="file"
          label="فایل اکسل"
          kinds={[FILE_KINDS.xlsx]}
          maxBytes={BULK_IMPORT_LIMITS.maxFileBytes}
          required
          busy={busy}
        />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          بارگذاری و پیش‌نمایش
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}
