'use client';

import { unwrap } from '@sepehr/api-client';
import type { JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  CheckboxField,
  DateField,
  defined,
  errorMessage,
  formText,
  Notice,
  SelectField,
  TextField,
  useApi,
  type SelectOption,
} from '@sepehr/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** The contract term (ADR-046): required at registration (owner 1405/07/27). */
export function ContractTermFields({
  idPrefix,
  today,
  startsOn,
  onStartsOn,
}: {
  idPrefix: string;
  today: JalaliDate;
  startsOn: JalaliDate | null;
  onStartsOn: (day: JalaliDate | null) => void;
}) {
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3">
      <legend className="font-bold">مدت قرارداد (الزامی)</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <DateField
          mode="single"
          label="روز شروع قرارداد"
          today={today}
          value={startsOn}
          onChange={onStartsOn}
        />
        <SelectField
          id={`${idPrefix}-term-months`}
          name="term-months"
          label="مدت قرارداد"
          defaultValue="12"
          options={[
            { value: '3', label: '۳ ماه' },
            { value: '6', label: '۶ ماه' },
            { value: '12', label: '۱۲ ماه' },
          ]}
        />
      </div>
      <p className="text-[length:var(--text-sm)] text-muted">
        مدت با تأیید نفر دوم در صفحه نرخ‌های تسویه در اجرا می‌آید. پس از پایان آن، خدمت تازه ثبت
        نمی‌شود.
      </p>
    </fieldset>
  );
}

/** The fields ticked in a form: `field-<code>` checkboxes. */
export function tickedFields(form: HTMLFormElement, fields: readonly SelectOption[]): string[] {
  const data = new FormData(form);
  return fields.filter((f) => data.get(`field-${f.value}`) === 'true').map((f) => f.value);
}

export function FieldChoices({ fields }: { fields: readonly SelectOption[] }) {
  if (fields.length === 0) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="font-bold">فیلدهای درمان</legend>
      <div className="flex flex-wrap gap-4">
        {fields.map((f) => (
          <CheckboxField
            key={f.value}
            id={`field-${f.value}`}
            name={`field-${f.value}`}
            label={f.label}
          />
        ))}
      </div>
    </fieldset>
  );
}

const optional = (form: HTMLFormElement, name: string) => {
  const value = formText(form, name);
  return value ? value : undefined;
};

/**
 * Registering a center (doc 08 §3; owner 1405/07/27 and 07/29): never saved without its contract
 * term. The center starts as a draft; activation stays a two-person request on its page.
 */
export function RegisterCenterForm({
  today,
  cities,
  fields,
}: {
  today: JalaliDate;
  cities: readonly SelectOption[];
  fields: readonly SelectOption[];
}) {
  const api = useApi();
  const router = useRouter();
  const [startsOn, setStartsOn] = useState<JalaliDate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4 rounded-lg border border-border bg-surface p-4"
      noValidate
      aria-label="ثبت مرکز"
      onSubmit={(e) => {
        e.preventDefault();
        if (!startsOn) {
          setError('روز شروع قرارداد را انتخاب کنید.');
          return;
        }
        const form = e.currentTarget;
        const personType = formText(form, 'person-type') === 'legal' ? 'legal' : 'natural';
        const months = Number(formText(form, 'term-months'));
        setBusy(true);
        setError(null);
        void unwrap(
          api.POST('/api/v1/catalog/centers', {
            body: {
              personType,
              identifier: formText(form, 'identifier'),
              cityCode: formText(form, 'city'),
              name: formText(form, 'name'),
              ...defined({
                address: optional(form, 'address'),
                phone: optional(form, 'phone'),
                licenseNumber: optional(form, 'license'),
              }),
              treatmentFieldCodes: tickedFields(form, fields),
              contractTerm: {
                startsOn: apiDay(startsOn),
                months: months === 3 ? 3 : months === 6 ? 6 : 12,
              },
            },
          }),
        )
          .then((center) => {
            router.push(`/centers/${center.id}`);
          })
          .catch((err: unknown) => {
            setError(errorMessage(err));
            setBusy(false);
          });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="center-name" name="name" label="نام مرکز" required />
        <SelectField
          id="center-city"
          name="city"
          label="شهر"
          emptyLabel="انتخاب شهر"
          options={cities}
        />
        <SelectField
          id="center-person-type"
          name="person-type"
          label="نوع شخص"
          defaultValue="legal"
          options={[
            { value: 'legal', label: 'حقوقی' },
            { value: 'natural', label: 'حقیقی' },
          ]}
        />
        <TextField
          id="center-identifier"
          name="identifier"
          label="شناسه ملی یا کد ملی"
          dir="ltr"
          figures
          required
        />
        <TextField id="center-phone" name="phone" label="تلفن" dir="ltr" figures />
        <TextField id="center-license" name="license" label="شماره پروانه" dir="ltr" />
      </div>
      <TextField id="center-address" name="address" label="نشانی" />
      <FieldChoices fields={fields} />
      <ContractTermFields
        idPrefix="center"
        today={today}
        startsOn={startsOn}
        onStartsOn={(d) => {
          setStartsOn(d);
          setError(null);
        }}
      />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت مرکز
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
    </form>
  );
}
