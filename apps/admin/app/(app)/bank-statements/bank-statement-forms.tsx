'use client';

import { unwrap } from '@sepehr/api-client';
import type { BankColumnMap } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  faDigits,
  FILE_KINDS,
  FileDropzone,
  formText,
  Notice,
  SelectField,
  TextField,
  toman,
  useApi,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Preview = {
  headers: string[];
  sampleRows: string[][];
  suggestedMap: BankColumnMap | null;
  mapped: { totalRial: string; validRows: number; invalidRows: number } | null;
};

/**
 * The file, its columns mapped (the last mapping offered), a preview of what it reads and its
 * sum, then the import: once per file. Then its rows (task 6-3).
 */
export function StatementImporter() {
  const api = useApi();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [map, setMap] = useState<BankColumnMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (
    path: '/api/v1/repayment/bank-statements/preview' | '/api/v1/repayment/bank-statements',
    withMap: BankColumnMap | null,
  ) => {
    if (!file) return null;
    return unwrap(
      api.POST(path, {
        body: { map: withMap ? JSON.stringify(withMap) : undefined } as never,
        bodySerializer: () => {
          const data = new FormData();
          if (withMap) data.append('map', JSON.stringify(withMap));
          data.append('file', file, file.name);
          return data;
        },
      }),
    );
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const columns =
    preview?.headers.map((h, i) => ({ value: String(i), label: h || `ستون ${faDigits(i + 1)}` })) ??
    [];
  const optional = [{ value: '', label: 'ندارد' }, ...columns];

  return (
    <section
      className="space-y-3 rounded-md border border-border p-3"
      aria-labelledby="import-title"
    >
      <h2 id="import-title" className="font-bold">
        ورود صورت‌حساب
      </h2>
      <FileDropzone
        id="statement-file"
        name="statement"
        label="فایل صورت‌حساب"
        kinds={[FILE_KINDS.xlsx, FILE_KINDS.csv]}
        maxBytes={5 * 1024 * 1024}
        required
        onFileChange={(f) => {
          setFile(f);
          setPreview(null);
          setMap(null);
        }}
      />
      <button
        type="button"
        disabled={!file || busy}
        className={buttonClass('secondary')}
        onClick={() =>
          void run(async () => {
            const p = (await send(
              '/api/v1/repayment/bank-statements/preview',
              null,
            )) as Preview | null;
            setPreview(p);
            setMap(p?.suggestedMap ?? null);
          })
        }
      >
        خواندن ستون‌ها
      </button>
      {preview && (
        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const column = (name: string) => {
              const v = formText(form, name);
              return v === '' ? null : Number(v);
            };
            const next: BankColumnMap = {
              dateColumn: column('dateColumn') ?? 0,
              amountColumn: column('amountColumn') ?? 1,
              refColumn: column('refColumn'),
              descriptionColumn: column('descriptionColumn'),
              amountUnit: formText(form, 'amountUnit') === 'toman' ? 'toman' : 'rial',
              headerRow: formText(form, 'headerRow') !== 'no',
            };
            void run(async () => {
              setMap(next);
              setPreview(
                (await send('/api/v1/repayment/bank-statements/preview', next)) as Preview,
              );
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField
              id="map-date"
              name="dateColumn"
              label="ستون روز"
              options={columns}
              defaultValue={String(map?.dateColumn ?? 0)}
            />
            <SelectField
              id="map-amount"
              name="amountColumn"
              label="ستون مبلغ"
              options={columns}
              defaultValue={String(map?.amountColumn ?? 1)}
            />
            <SelectField
              id="map-ref"
              name="refColumn"
              label="ستون شماره پیگیری"
              options={optional}
              defaultValue={map?.refColumn == null ? '' : String(map.refColumn)}
            />
            <SelectField
              id="map-desc"
              name="descriptionColumn"
              label="ستون شرح"
              options={optional}
              defaultValue={map?.descriptionColumn == null ? '' : String(map.descriptionColumn)}
            />
            <SelectField
              id="map-unit"
              name="amountUnit"
              label="واحد مبلغ در فایل"
              options={[
                { value: 'rial', label: 'ریال' },
                { value: 'toman', label: 'تومان' },
              ]}
              defaultValue={map?.amountUnit ?? 'rial'}
            />
            <SelectField
              id="map-header"
              name="headerRow"
              label="ردیف اول"
              options={[
                { value: 'yes', label: 'عنوان ستون‌هاست' },
                { value: 'no', label: 'تراکنش است' },
              ]}
              defaultValue={map?.headerRow === false ? 'no' : 'yes'}
            />
          </div>
          <button type="submit" disabled={busy} className={buttonClass('secondary')}>
            پیش‌نمایش با این نگاشت
          </button>
        </form>
      )}
      {preview?.mapped && map && (
        <div className="space-y-2">
          <p className="figures">
            {faDigits(preview.mapped.validRows)} ردیف معتبر، {faDigits(preview.mapped.invalidRows)}{' '}
            ردیف نامعتبر؛ جمع {toman(preview.mapped.totalRial)}
          </p>
          <button
            type="button"
            disabled={busy}
            className={buttonClass('primary')}
            onClick={() =>
              void run(async () => {
                const made = (await send('/api/v1/repayment/bank-statements', map)) as {
                  id: string;
                } | null;
                if (made) router.push(`/bank-statements?import=${made.id}`);
              })
            }
          >
            ثبت صورت‌حساب و پیشنهاد تطبیق
          </button>
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}

/** An unknown deposit looked at, with a note (staff enter it as a slip if it is one). */
export function ReviewRow({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const note = formText(e.currentTarget, 'note').trim();
        setError(null);
        void unwrap(
          api.POST('/api/v1/repayment/bank-statements/rows/{id}/review', {
            params: { path: { id } },
            body: { note },
          }),
        )
          .then(() => {
            router.refresh();
          })
          .catch((err: unknown) => {
            setError(errorMessage(err));
          });
      }}
    >
      <TextField id={`note-${id}`} name="note" label="یادداشت بررسی" required />
      <button type="submit" className={buttonClass('secondary')}>
        ثبت بررسی
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
