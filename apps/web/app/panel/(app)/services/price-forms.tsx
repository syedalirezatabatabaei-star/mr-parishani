'use client';

import { unwrap } from '@sepehr/api-client';
import { parseRial } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  formText,
  MoneyField,
  Notice,
  SelectField,
  TextField,
  useApi,
  type SelectOption,
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
  return { busy, error, done, run, setError };
}

/** A new price from now on; earlier bookings keep the price they were quoted (rule 16). */
export function NewPriceForm({
  workplaceId,
  services,
}: {
  workplaceId: string;
  services: readonly SelectOption[];
}) {
  const api = useApi();
  const { busy, error, done, run, setError } = useAction();
  const [free, setFree] = useState(false);
  return (
    <section
      aria-labelledby="new-price"
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
    >
      <h2 id="new-price" className="text-[length:var(--text-lg)] font-bold">
        تعرفه تازه
      </h2>
      <form
        className="space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const serviceCode = formText(form, 'service');
          const reason = formText(form, 'reason');
          let pricing: { kind: 'free' } | { kind: 'range'; minRial: string; maxRial: string };
          if (free) {
            pricing = { kind: 'free' };
          } else {
            const min = parseRial(formText(form, 'min'));
            const max = parseRial(formText(form, 'max') || formText(form, 'min'));
            if (!min || !max) {
              setError('مبلغ را به ریال و فقط با رقم بنویسید.');
              return;
            }
            pricing = { kind: 'range', minRial: min.toString(), maxRial: max.toString() };
          }
          void run(
            () =>
              unwrap(
                api.POST('/api/v1/catalog/tariffs', {
                  body: {
                    owner: { kind: 'workplace', workplaceId },
                    serviceCode,
                    pricing,
                    reason,
                  },
                }),
              ),
            'تعرفه ثبت شد.',
          );
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            id="price-service"
            name="service"
            label="خدمت"
            options={services}
            defaultValue="visit"
          />
          {!free && (
            <>
              <MoneyField id="price-min" name="min" label="از" />
              <MoneyField id="price-max" name="max" label="تا" hint="خالی: همان مبلغ «از»" />
            </>
          )}
          <label className="flex min-h-10 items-center gap-2 text-[length:var(--text-sm)]">
            <input
              type="checkbox"
              checked={free}
              onChange={(e) => {
                setFree(e.target.checked);
              }}
              className="size-5 accent-[var(--color-accent)]"
            />
            رایگان (فقط ویزیت)
          </label>
        </div>
        <TextField id="price-reason" name="reason" label="دلیل" required />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          ثبت تعرفه
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </section>
  );
}

/** Withdrawing a service from now on, or cancelling a price not yet in force. */
export function VersionActions(
  props: { kind: 'withdraw'; tariffId: string } | { kind: 'cancel'; versionId: string },
) {
  const api = useApi();
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const label = props.kind === 'withdraw' ? 'توقف ارائه' : 'لغو این تغییر';
  if (!open) {
    return (
      <button
        type="button"
        className={buttonClass('quiet', 'min-h-9 px-2')}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </button>
    );
  }
  const id = props.kind === 'withdraw' ? props.tariffId : props.versionId;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const reason = formText(e.currentTarget, 'reason');
        void run(
          () =>
            props.kind === 'withdraw'
              ? unwrap(
                  api.POST('/api/v1/catalog/tariffs/{id}/withdraw', {
                    params: { path: { id } },
                    body: { reason },
                  }),
                )
              : unwrap(
                  api.POST('/api/v1/catalog/tariff-versions/{id}/cancel', {
                    params: { path: { id } },
                    body: { reason },
                  }),
                ),
          'انجام شد.',
        );
      }}
    >
      <TextField id={`reason-${id}`} name="reason" label="دلیل" required error={error} />
      <button type="submit" disabled={busy} className={buttonClass('danger')}>
        {label}
      </button>
      <button
        type="button"
        className={buttonClass('quiet')}
        onClick={() => {
          setOpen(false);
        }}
      >
        انصراف
      </button>
    </form>
  );
}

/** The prices an Excel import proposed for this center, applied together with a reason. */
export function ProposedTariffs({
  centerId,
  rows,
}: {
  centerId: string;
  rows: readonly { rowId: string; serviceName: string; owner: string; price: string }[];
}) {
  const api = useApi();
  const { busy, error, done, run } = useAction();
  return (
    <section
      aria-labelledby="proposed"
      className="space-y-3 rounded-lg border-2 border-highlight bg-surface p-4"
    >
      <h2 id="proposed" className="text-[length:var(--text-lg)] font-bold">
        تعرفه‌های پیشنهادی ورود از اکسل
      </h2>
      <ul className="space-y-1 text-[length:var(--text-sm)]">
        {rows.map((r) => (
          <li key={r.rowId} className="figures">
            {r.serviceName} ({r.owner === 'center' ? 'کل مرکز' : 'این پزشک'}): {r.price}
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const reason = formText(e.currentTarget, 'reason');
          void run(
            () =>
              unwrap(
                api.POST('/api/v1/catalog/centers/{id}/proposed-tariffs/apply', {
                  params: { path: { id: centerId } },
                  body: { reason },
                }),
              ),
            'تعرفه‌های پیشنهادی اعمال شد.',
          );
        }}
      >
        <TextField id="proposed-reason" name="reason" label="دلیل" required />
        <button type="submit" disabled={busy} className={buttonClass('primary')}>
          اعمال همه
        </button>
      </form>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </section>
  );
}
