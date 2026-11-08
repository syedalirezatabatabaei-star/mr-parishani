'use client';

import { unwrap } from '@sepehr/api-client';
import { normalizeMobile } from '@sepehr/contracts';
import {
  buttonClass,
  errorMessage,
  faDigits,
  FILE_KINDS,
  FileDropzone,
  Glyph,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  useApi,
  type SelectOption,
} from '@sepehr/ui';
import { useEffect, useState, type ReactNode, type SubmitEvent } from 'react';
import { solveProofOfWork } from '../../lib/pow';
import {
  asciiDigits,
  DOCUMENTS,
  MAX_FILE_BYTES,
  joinProblems,
  MAX_DOCTORS,
  PLACE_KINDS,
  type JoinDoctor,
} from './join-model';

/** The errors with one field's set, or cleared when `error` is null. */
function withError(
  all: Record<string, string>,
  field: string,
  error: string | null,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (k !== field) next[k] = v;
  if (error) next[field] = error;
  return next;
}

/** The hidden field's value: empty, unless a bot filled it. */
function honeypot(): string {
  const field = document.getElementById('website');
  return field instanceof HTMLInputElement ? field.value : '';
}

/** A doctor's row, with a key of its own: removing one keeps the others' typed values. */
type Row = JoinDoctor & { key: number };
let nextKey = 0;
const emptyRow = (): Row => ({ key: (nextKey += 1), name: '', council: '', specialty: '' });

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="mb-3 flex items-center gap-2 font-bold">
        <span className="figures grid size-7 place-items-center rounded-full bg-accent text-[length:var(--text-sm)] text-on-accent">
          {faDigits(n)}
        </span>
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * The request form (owner 1405/08/10): the center, the person in charge and their mobile proved
 * by a code, the doctors, the documents. Against bots, with no outside service: a light proof of
 * work the page solves before each code and each request, the API's limits per mobile and
 * address, and a field only bots fill. The request goes to the network specialist's queue.
 */
export function JoinForm({
  cities,
  fields,
}: {
  cities: readonly SelectOption[];
  fields: readonly SelectOption[];
}) {
  const [person, setPerson] = useState<'natural' | 'legal' | ''>('');
  const [doctors, setDoctors] = useState<Row[]>(() => [emptyRow()]);
  const [files, setFiles] = useState<Record<string, File | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const api = useApi(null);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => {
      setResendIn((left) => left - 1);
    }, 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [resendIn]);

  /** A fresh challenge, solved in the page. */
  const proof = async () => {
    setBusy('بررسی امنیتی صفحه…');
    const challenge = await unwrap(api.GET('/api/v1/catalog/partnership/challenge'));
    const counter = await solveProofOfWork(challenge.challenge, challenge.bits);
    return { challenge: challenge.challenge, counter };
  };

  const sendCode = async () => {
    const input = document.getElementById('mobile');
    const typed = input instanceof HTMLInputElement ? input.value : '';
    const mobile = normalizeMobile(asciiDigits(typed));
    if (!mobile) {
      setErrors((all) => withError(all, 'mobile', 'شماره موبایل درست نیست؛ مانند ۰۹۱۲۳۴۵۶۷۸۹.'));
      return;
    }
    setFailure(null);
    try {
      const sentCode = await unwrap(
        api.POST('/api/v1/catalog/partnership/code', {
          body: { mobile, proof: await proof(), website: honeypot() },
        }),
      );
      setCodeSentTo(mobile);
      setResendIn(sentCode.resendAfterSeconds);
      setErrors((all) => withError(all, 'mobile', null));
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const setDoctor = (i: number, key: keyof JoinDoctor, value: string) => {
    setDoctors((all) => all.map((d, j) => (j === i ? { ...d, [key]: value } : d)));
  };

  const onSubmit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => {
      const v = form.get(name);
      return typeof v === 'string' ? v : '';
    };
    const problems = joinProblems({
      centerName: text('centerName'),
      kind: text('kind'),
      person,
      city: text('city'),
      fields: fields.filter((f) => form.get(`field-${f.value}`) === 'on').map((f) => f.value),
      address: text('address'),
      managerName: text('managerName'),
      mobile: text('mobile'),
      doctors,
      files: Object.fromEntries(
        Object.entries(files).map(([k, f]) => [k, f ? { type: f.type, size: f.size } : undefined]),
      ),
      consent: form.get('consent') === 'on',
    });
    setErrors(problems);
    if (Object.keys(problems).length > 0) {
      document.getElementById(Object.keys(problems)[0] ?? '')?.focus();
      return;
    }
    const code = asciiDigits(text('code')).trim();
    if (!codeSentTo || !/^\d{6}$/.test(code)) {
      setErrors({ code: 'کد تأیید پیامکی شش‌رقمی را بنویسید.' });
      if (!codeSentTo) setFailure('اول کد تأیید را به موبایل مسئول بفرستید.');
      document.getElementById(codeSentTo ? 'code' : 'mobile')?.focus();
      return;
    }
    const target = e.currentTarget;
    const request = {
      centerName: text('centerName'),
      placeKind: text('kind'),
      personType: person,
      cityCode: text('city'),
      treatmentFieldCodes: fields
        .filter((f) => form.get(`field-${f.value}`) === 'on')
        .map((f) => f.value),
      address: text('address'),
      phone: asciiDigits(text('phone')).trim() || null,
      managerName: text('managerName'),
      managerRole: text('role').trim() || null,
      mobile: codeSentTo,
      code,
      doctors: doctors
        .filter((d) => d.name.trim() || d.council.trim())
        .map((d) => ({
          name: d.name,
          councilNumber: asciiDigits(d.council),
          specialty: d.specialty.trim() || null,
        })),
      website: honeypot(),
    };
    void (async () => {
      setFailure(null);
      try {
        const body = JSON.stringify({ ...request, proof: await proof() });
        setBusy('ارسال درخواست و مدارک…');
        const receipt = await unwrap(
          api.POST('/api/v1/catalog/partnership/requests', {
            body: { request: body },
            bodySerializer: () => {
              const data = new FormData();
              data.append('request', body);
              for (const [kind, file] of Object.entries(files)) {
                if (file) data.append(kind, file, file.name);
              }
              return data;
            },
          }),
        );
        setSent(receipt.number);
        target.reset();
        setDoctors([emptyRow()]);
        setFiles({});
        setCodeSentTo(null);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (error) {
        setFailure(errorMessage(error));
      } finally {
        setBusy(null);
      }
    })();
  };

  if (sent !== null) {
    return (
      <div className="space-y-4">
        <Notice tone="success" title="درخواست شما ثبت شد">
          کد پیگیری: <span className="figures font-bold">{faDigits(sent)}</span>. کارشناس شبکه درمان
          درخواست و مدارک را بررسی می‌کند و نتیجه به موبایل مسئول پیامک می‌شود.
        </Notice>
        <button
          type="button"
          onClick={() => {
            setSent(null);
          }}
          className={buttonClass('secondary')}
        >
          درخواست دیگر
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      onInput={(e) => {
        // A doctor's typed values reach the list as they change.
        const target = e.target as HTMLInputElement;
        const m = /^doctor-(\d+)-(name|council|specialty)$/.exec(target.name);
        if (m) setDoctor(Number(m[1]), m[2] as keyof JoinDoctor, target.value);
      }}
      noValidate
      aria-label="درخواست همکاری"
      className="space-y-8"
    >
      {/* A field people never see; a bot fills it (the API then refuses without a reason). */}
      <div aria-hidden="true" className="absolute -start-[9999px] size-px overflow-hidden">
        <label htmlFor="website">وب‌سایت</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <Step n={1} title="مرکز درمانی">
        <TextField
          id="centerName"
          name="centerName"
          label="نام مرکز یا مطب"
          required
          error={errors['centerName'] ?? null}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="kind"
            name="kind"
            label="نوع مرکز"
            options={PLACE_KINDS}
            emptyLabel="انتخاب کنید"
            error={errors['kind'] ?? null}
          />
          <SelectField
            id="person"
            name="person"
            label="نوع شخص"
            options={[
              { value: 'natural', label: 'حقیقی (مطب، پزشک)' },
              { value: 'legal', label: 'حقوقی (شرکت، مؤسسه)' },
            ]}
            emptyLabel="انتخاب کنید"
            onChange={(v) => {
              setPerson(v === 'natural' || v === 'legal' ? v : '');
            }}
            error={errors['person'] ?? null}
          />
          <SelectField
            id="city"
            name="city"
            label="شهر"
            options={cities}
            emptyLabel="انتخاب کنید"
            error={errors['city'] ?? null}
          />
          <TextField
            id="phone"
            name="phone"
            label="تلفن ثابت (اختیاری)"
            type="tel"
            inputMode="tel"
            dir="ltr"
            figures
          />
        </div>
        {fields.length > 0 && (
          <fieldset
            id="fields"
            tabIndex={-1}
            aria-describedby={errors['fields'] ? 'fields-error' : undefined}
            className="space-y-2"
          >
            <legend className="text-[length:var(--text-sm)] font-medium">رشته‌های درمان</legend>
            <div className="flex flex-wrap gap-2">
              {fields.map((f) => (
                <label
                  key={f.value}
                  className="inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border border-border-strong px-3 has-checked:border-accent has-checked:bg-accent-soft has-checked:text-on-accent-soft"
                >
                  <input type="checkbox" name={`field-${f.value}`} className="accent-accent" />
                  {f.label}
                </label>
              ))}
            </div>
            {errors['fields'] && (
              <p
                id="fields-error"
                role="alert"
                className="text-[length:var(--text-sm)] text-danger"
              >
                {errors['fields']}
              </p>
            )}
          </fieldset>
        )}
        <TextAreaField
          id="address"
          name="address"
          label="نشانی"
          rows={2}
          maxLength={300}
          error={errors['address'] ?? null}
        />
      </Step>

      <Step n={2} title="مسئول مرکز">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="managerName"
            name="managerName"
            label="نام و نام خانوادگی"
            autoComplete="name"
            error={errors['managerName'] ?? null}
          />
          <TextField id="role" name="role" label="سمت (اختیاری)" />
        </div>
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
          <TextField
            id="mobile"
            name="mobile"
            label="موبایل مسئول"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            figures
            hint="کد تأیید و نتیجه بررسی به همین شماره پیامک می‌شود."
            error={errors['mobile'] ?? null}
          />
          <button
            type="button"
            disabled={busy !== null || resendIn > 0}
            onClick={() => {
              void sendCode();
            }}
            className={buttonClass('secondary', 'sm:mb-6')}
          >
            {resendIn > 0
              ? `ارسال دوباره تا ${faDigits(resendIn)} ثانیه`
              : codeSentTo
                ? 'ارسال دوباره کد'
                : 'ارسال کد تأیید'}
          </button>
        </div>
        {codeSentTo && (
          <TextField
            id="code"
            name="code"
            label="کد تأیید پیامکی"
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
            figures
            hint={`کد شش‌رقمی به شماره پایان‌یافته به ${faDigits(codeSentTo.slice(-4))} پیامک شد.`}
            error={errors['code'] ?? null}
          />
        )}
      </Step>

      <Step n={3} title="پزشکان">
        <ul id="doctors" tabIndex={-1} aria-label="پزشکان مرکز" className="space-y-3">
          {doctors.map((d, i) => {
            const n = faDigits(i + 1);
            return (
              <li
                key={d.key}
                className="grid gap-3 rounded-md border border-border bg-sunken/50 p-3 sm:grid-cols-[1.4fr_1fr_1fr_auto] sm:items-start"
              >
                <TextField
                  id={`doctor-${String(i)}-name`}
                  name={`doctor-${String(i)}-name`}
                  label={`نام پزشک ${n}`}
                  defaultValue={d.name}
                  error={errors[`doctor-${String(i)}-name`] ?? null}
                />
                <TextField
                  id={`doctor-${String(i)}-council`}
                  name={`doctor-${String(i)}-council`}
                  label={`نظام پزشکی پزشک ${n}`}
                  inputMode="numeric"
                  dir="ltr"
                  figures
                  defaultValue={d.council}
                  error={errors[`doctor-${String(i)}-council`] ?? null}
                />
                <TextField
                  id={`doctor-${String(i)}-specialty`}
                  name={`doctor-${String(i)}-specialty`}
                  label={`تخصص پزشک ${n}`}
                  defaultValue={d.specialty}
                />
                {doctors.length > 1 && (
                  <button
                    type="button"
                    aria-label={`حذف پزشک ${n}`}
                    onClick={() => {
                      setDoctors((all) => all.filter((_, j) => j !== i));
                    }}
                    className="grid size-11 place-items-center self-center rounded-md text-ink-muted hover:bg-sunken sm:mt-6"
                  >
                    <Glyph name="close" className="size-5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {errors['doctors'] && (
          <p role="alert" className="text-[length:var(--text-sm)] text-danger">
            {errors['doctors']}
          </p>
        )}
        {doctors.length < MAX_DOCTORS && (
          <button
            type="button"
            onClick={() => {
              setDoctors((all) => [...all, emptyRow()]);
            }}
            className={buttonClass('secondary')}
          >
            افزودن پزشک
          </button>
        )}
      </Step>

      <Step n={4} title="مدارک">
        <p className="text-[length:var(--text-sm)] text-ink-muted">
          فایل‌ها پیش از بررسی از نظر ویروس اسکن می‌شوند.
        </p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {DOCUMENTS.filter((doc) => !doc.legalOnly || person === 'legal').map((doc) => {
            return (
              <li key={doc.key}>
                <FileDropzone
                  id={`file-${doc.key}`}
                  name={`file-${doc.key}`}
                  label={doc.label}
                  kinds={[FILE_KINDS.pdf, FILE_KINDS.jpg, FILE_KINDS.png]}
                  maxBytes={MAX_FILE_BYTES}
                  required={doc.required}
                  busy={busy !== null}
                  error={errors[`file-${doc.key}`] ?? null}
                  onFileChange={(chosen) => {
                    setFiles((all) => ({ ...all, [doc.key]: chosen ?? undefined }));
                    setErrors((all) => withError(all, `file-${doc.key}`, null));
                  }}
                />
              </li>
            );
          })}
        </ul>
      </Step>

      <div className="space-y-4 border-t border-border pt-6">
        <label className="flex items-start gap-2 text-[length:var(--text-sm)]">
          <input
            id="consent"
            type="checkbox"
            name="consent"
            aria-describedby={errors['consent'] ? 'consent-error' : undefined}
            className="mt-1 size-4 accent-accent"
          />
          <span>
            درستی اطلاعات و مدارک را تأیید می‌کنم و می‌دانم بررسی آن چند روز کاری طول می‌کشد.
          </span>
        </label>
        {errors['consent'] && (
          <p id="consent-error" role="alert" className="text-[length:var(--text-sm)] text-danger">
            {errors['consent']}
          </p>
        )}
        {failure && <Notice tone="danger">{failure}</Notice>}
        <button type="submit" disabled={busy !== null} className={buttonClass('primary', 'w-full')}>
          {busy ?? 'ارسال درخواست همکاری'}
        </button>
      </div>
    </form>
  );
}
