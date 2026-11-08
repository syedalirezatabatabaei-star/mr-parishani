'use client';

import { unwrap } from '@sepehr/api-client';
import type { JalaliDate } from '@sepehr/contracts';
import {
  apiDay,
  buttonClass,
  defined,
  errorMessage,
  formText,
  Notice,
  SelectField,
  TextField,
  useApi,
  type SelectOption,
} from '@sepehr/ui';
import { useState } from 'react';
import {
  ContractTermFields,
  FieldChoices,
  tickedFields,
} from '../../centers/new/register-center-form';

/**
 * Registering a doctor (doc 08 §4; owner 1405/07/27 and 07/29) at a first workplace, a branch of
 * an active center or their own private practice, never without the contract term (ADR-046).
 */
export function RegisterDoctorForm({
  today,
  cities,
  fields,
  branches,
}: {
  today: JalaliDate;
  cities: readonly SelectOption[];
  fields: readonly SelectOption[];
  /** The branches of active centers: «center · branch». */
  branches: readonly SelectOption[];
}) {
  const api = useApi();
  const [kind, setKind] = useState<'branch' | 'private_practice'>(
    branches.length > 0 ? 'branch' : 'private_practice',
  );
  const [startsOn, setStartsOn] = useState<JalaliDate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form
      className="space-y-4 rounded-lg border border-border bg-surface p-4"
      noValidate
      aria-label="ثبت پزشک"
      onSubmit={(e) => {
        e.preventDefault();
        if (!startsOn) {
          setError('روز شروع قرارداد را انتخاب کنید.');
          return;
        }
        const form = e.currentTarget;
        const months = Number(formText(form, 'term-months'));
        const nationalId = formText(form, 'national-id');
        setBusy(true);
        setError(null);
        setDone(null);
        void unwrap(
          api.POST('/api/v1/catalog/doctors', {
            body: {
              name: formText(form, 'name'),
              medicalCouncilNumber: formText(form, 'council'),
              ...defined({ nationalId: nationalId ? nationalId : undefined }),
              treatmentFieldCodes: tickedFields(form, fields),
              workplace:
                kind === 'branch'
                  ? { kind: 'branch', branchId: formText(form, 'branch') }
                  : { kind: 'private_practice', cityCode: formText(form, 'city') },
              reason: formText(form, 'reason'),
              contractTerm: {
                startsOn: apiDay(startsOn),
                months: months === 3 ? 3 : months === 6 ? 6 : 12,
              },
            },
          }),
        )
          .then((doctor) => {
            setDone(`پزشک «${doctor.name}» ثبت شد. مدت قرارداد منتظر تأیید نفر دوم است.`);
            form.reset();
            setStartsOn(null);
          })
          .catch((err: unknown) => {
            setError(errorMessage(err));
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="doctor-name" name="name" label="نام پزشک" required />
        <TextField
          id="doctor-council"
          name="council"
          label="شماره نظام پزشکی"
          dir="ltr"
          figures
          required
        />
        <TextField id="doctor-national-id" name="national-id" label="کد ملی" dir="ltr" figures />
        <SelectField
          id="doctor-workplace-kind"
          name="workplace-kind"
          label="محل کار نخست"
          defaultValue={kind}
          onChange={(v) => {
            setKind(v === 'branch' ? 'branch' : 'private_practice');
          }}
          options={[
            ...(branches.length > 0 ? [{ value: 'branch', label: 'شعبه یک مرکز فعال' }] : []),
            { value: 'private_practice', label: 'مطب شخصی' },
          ]}
        />
        {kind === 'branch' ? (
          <SelectField
            id="doctor-branch"
            name="branch"
            label="شعبه"
            emptyLabel="انتخاب شعبه"
            options={branches}
          />
        ) : (
          <SelectField
            id="doctor-city"
            name="city"
            label="شهر مطب"
            emptyLabel="انتخاب شهر"
            options={cities}
          />
        )}
      </div>
      <FieldChoices fields={fields} />
      <ContractTermFields
        idPrefix="doctor"
        today={today}
        startsOn={startsOn}
        onStartsOn={(d) => {
          setStartsOn(d);
          setError(null);
        }}
      />
      <TextField id="doctor-reason" name="reason" label="دلیل ثبت" required />
      <button type="submit" disabled={busy} className={buttonClass('primary')}>
        ثبت پزشک
      </button>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
    </form>
  );
}
