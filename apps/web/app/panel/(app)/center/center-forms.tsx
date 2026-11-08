'use client';

import { unwrap } from '@sepehr/api-client';
import type { BranchViewBody } from '@sepehr/contracts';
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
import { useState } from 'react';

const PARKING = [
  { value: 'available', label: 'دارد' },
  { value: 'limited', label: 'محدود' },
  { value: 'none', label: 'ندارد' },
] as const;

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
  return { busy, error, done, run };
}

/** A branch and how to reach it (doc 08 §3: shown to patients after confirmation). */
export function BranchForm({ branch, canEdit }: { branch: BranchViewBody; canEdit: boolean }) {
  const api = useApi();
  const { busy, error, done, run } = useAction();
  const f = (name: string) => `${name}-${branch.id}`;
  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-surface p-4"
      noValidate
      aria-label={`شعبه ${branch.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const optional = (name: string) => {
          const value = formText(form, name).trim();
          return value === '' ? {} : { [name]: value };
        };
        const parking = formText(form, 'parking');
        void run(
          () =>
            unwrap(
              api.PATCH('/api/v1/catalog/branches/{id}', {
                params: { path: { id: branch.id } },
                body: {
                  ...optional('address'),
                  ...optional('phone'),
                  ...optional('nearestMetro'),
                  ...optional('nearestBrt'),
                  ...optional('routeNote'),
                  ...(parking ? { parking: parking as 'available' | 'limited' | 'none' } : {}),
                  reason: formText(form, 'reason'),
                },
              }),
            ),
          'شعبه ذخیره شد.',
        );
      }}
    >
      <p className="font-bold">
        {branch.name}
        {branch.isDefault ? ' (شعبه اصلی)' : ''}
      </p>
      <fieldset disabled={!canEdit} className="grid gap-3 sm:grid-cols-2">
        <TextField
          id={f('address')}
          name="address"
          label="نشانی"
          defaultValue={branch.address ?? ''}
          className="sm:col-span-2"
        />
        <TextField
          id={f('phone')}
          name="phone"
          label="تلفن"
          defaultValue={branch.phone ?? ''}
          dir="ltr"
          figures
        />
        <SelectField
          id={f('parking')}
          name="parking"
          label="پارکینگ"
          emptyLabel="نامشخص"
          defaultValue={branch.parking ?? ''}
          options={PARKING}
        />
        <TextField
          id={f('metro')}
          name="nearestMetro"
          label="نزدیک‌ترین ایستگاه مترو"
          defaultValue={branch.nearestMetro ?? ''}
        />
        <TextField
          id={f('brt')}
          name="nearestBrt"
          label="نزدیک‌ترین ایستگاه BRT"
          defaultValue={branch.nearestBrt ?? ''}
        />
        <TextField
          id={f('route')}
          name="routeNote"
          label="راهنمای رسیدن"
          defaultValue={branch.routeNote ?? ''}
          className="sm:col-span-2"
        />
      </fieldset>
      {canEdit && (
        <>
          <TextField id={f('reason')} name="reason" label="دلیل تغییر" required />
          <button type="submit" disabled={busy} className={buttonClass('primary')}>
            ذخیره شعبه
          </button>
        </>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </form>
  );
}

/**
 * Proposing a new Sheba: it takes effect only when a second person approves it, never the
 * proposer (doc 08 §15 test 8). The number itself is encrypted on the server (rule 27).
 */
export function BankAccountRequest({ centerId }: { centerId: string }) {
  const api = useApi();
  const { busy, error, done, run } = useAction();
  return (
    <form
      className="space-y-3 border-t border-border pt-3"
      noValidate
      aria-label="درخواست تغییر حساب بانکی"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        void run(
          () =>
            unwrap(
              api.POST('/api/v1/catalog/centers/{id}/bank-account-requests', {
                params: { path: { id: centerId } },
                body: {
                  sheba: formText(form, 'sheba'),
                  accountHolderName: formText(form, 'holder'),
                  reason: formText(form, 'reason'),
                },
              }),
            ),
          'درخواست ثبت شد و پس از تأیید نفر دوم اعمال می‌شود.',
        );
      }}
    >
      <p className="font-medium">درخواست تغییر حساب بانکی</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          id="sheba"
          name="sheba"
          label="شماره شبا"
          dir="ltr"
          figures
          placeholder="IR…"
          autoComplete="off"
        />
        <TextField id="holder" name="holder" label="نام صاحب حساب" />
      </div>
      <TextField id="sheba-reason" name="reason" label="دلیل" required />
      <button type="submit" disabled={busy} className={buttonClass('secondary')}>
        ثبت درخواست
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </form>
  );
}
