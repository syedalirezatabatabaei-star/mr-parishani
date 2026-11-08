'use client';

import { unwrap } from '@sepehr/api-client';
import {
  buttonClass,
  errorMessage,
  formText,
  Notice,
  SelectField,
  TextField,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';

type Params = Record<string, unknown>;

/** Saves the page's filter by name: its conditions only, never the rows (doc 17 §4). */
export function SaveFilterForm({
  code,
  conditions,
  units,
}: {
  code: string;
  conditions: Params;
  /** The units the account may share with (reporting.share_filters); none: not shared. */
  units: readonly { value: string; label: string }[];
}) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const sharedUnit = units.length > 0 ? formText(form, 'sharedUnit') : '';
    const body = {
      reportCode: code,
      name: formText(form, 'name'),
      conditions,
      ...(sharedUnit === '' ? {} : { sharedUnit }),
    };
    setBusy(true);
    setError(null);
    setSaved(false);
    void unwrap(api.POST('/api/v1/reporting/filters', { body }))
      .then(() => {
        form.reset();
        setSaved(true);
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
    <form onSubmit={submit} className="space-y-3" aria-label="ذخیره فیلتر" noValidate>
      <TextField id="filter-name" name="name" label="نام فیلتر" required />
      {units.length > 0 && (
        <SelectField
          id="filter-unit"
          name="sharedUnit"
          label="اشتراک با واحد"
          emptyLabel="فقط خودم"
          options={units}
        />
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {saved ? <Notice tone="success">فیلتر ذخیره شد.</Notice> : null}
      <button type="submit" disabled={busy} className={buttonClass('secondary')}>
        ذخیره فیلتر
      </button>
    </form>
  );
}

/** Removes one's own saved filter. */
export function DeleteFilterButton({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          void unwrap(
            api.POST('/api/v1/reporting/filters/{id}/delete', { params: { path: { id } } }),
          )
            .then(() => {
              router.refresh();
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            });
        }}
      >
        حذف
      </button>
      {error ? <span className="text-[length:var(--text-xs)] text-danger">{error}</span> : null}
    </span>
  );
}

/**
 * An export of exactly what the page shows (doc 17 §5): CSV or PDF, rials or tomans. A small
 * one is ready at once and opens; a large one, and every PDF, is made in the background and
 * appears in «خروجی‌های من».
 */
export function ExportForm({ code, params }: { code: string; params: Params }) {
  const api = useApi();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const format = formText(form, 'format') === 'pdf' ? ('pdf' as const) : ('csv' as const);
    const moneyUnit =
      formText(form, 'moneyUnit') === 'toman' ? ('toman' as const) : ('rial' as const);
    setBusy(true);
    setError(null);
    setQueued(false);
    void (async () => {
      try {
        const made = await unwrap(
          api.POST('/api/v1/reporting/reports/{code}/exports', {
            params: { path: { code } },
            body: { params, format, moneyUnit },
          }),
        );
        if (made.status === 'ready') {
          const link = await unwrap(
            api.GET('/api/v1/reporting/exports/{id}/link', { params: { path: { id: made.id } } }),
          );
          window.open(link.url, '_blank', 'noopener');
        } else {
          setQueued(true);
        }
        router.refresh();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="خروجی" noValidate>
      <SelectField
        id="export-format"
        name="format"
        label="قالب"
        options={[
          { value: 'csv', label: 'CSV (اکسل)' },
          { value: 'pdf', label: 'PDF' },
        ]}
      />
      <SelectField
        id="export-unit"
        name="moneyUnit"
        label="واحد مبلغ"
        options={[
          { value: 'rial', label: 'ریال' },
          { value: 'toman', label: 'تومان' },
        ]}
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {queued ? (
        <Notice tone="info">خروجی در صف ساخته می‌شود؛ در «خروجی‌های من» آماده می‌شود.</Notice>
      ) : null}
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        دریافت خروجی
      </button>
    </form>
  );
}

/** A ready export's file, by a short-lived signed link (rule 28). */
export function ExportLinkButton({ id }: { id: string }) {
  const api = useApi();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          void unwrap(api.GET('/api/v1/reporting/exports/{id}/link', { params: { path: { id } } }))
            .then((link) => {
              window.open(link.url, '_blank', 'noopener');
            })
            .catch((err: unknown) => {
              setError(errorMessage(err));
            });
        }}
      >
        دریافت
      </button>
      {error ? <span className="text-[length:var(--text-xs)] text-danger">{error}</span> : null}
    </span>
  );
}

/** The page as printed: the print stylesheet leaves out the menu, filters and buttons. */
export function PrintButton() {
  return (
    <button
      type="button"
      className={buttonClass('secondary', 'print:hidden')}
      onClick={() => {
        window.print();
      }}
    >
      چاپ
    </button>
  );
}
