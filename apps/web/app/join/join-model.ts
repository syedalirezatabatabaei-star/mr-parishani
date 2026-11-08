import { normalizeMobile } from '@sepehr/contracts';

/** The kinds of place a request names (owner 1405/08/10). */
export const PLACE_KINDS = [
  { value: 'practice', label: 'مطب' },
  { value: 'clinic', label: 'کلینیک' },
  { value: 'polyclinic', label: 'درمانگاه' },
  { value: 'hospital', label: 'بیمارستان' },
  { value: 'day_surgery', label: 'مرکز جراحی محدود' },
  { value: 'imaging', label: 'مرکز تصویربرداری' },
  { value: 'laboratory', label: 'آزمایشگاه' },
  { value: 'dental', label: 'مرکز دندان‌پزشکی' },
] as const;

/** A document the request carries: which, whether it is needed, for whom. */
export const DOCUMENTS = [
  { key: 'license', label: 'پروانه فعالیت یا بهره‌برداری', required: true, legalOnly: false },
  { key: 'owner_id', label: 'کارت ملی مسئول', required: true, legalOnly: false },
  { key: 'iban', label: 'گواهی شماره شبا', required: false, legalOnly: false },
  { key: 'gazette', label: 'روزنامه رسمی آخرین تغییرات', required: true, legalOnly: true },
] as const;

/** Files the reviewer can open: PDF and photos, each at most 10 MB. */
export const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCTORS = 20;

export interface JoinDoctor {
  name: string;
  council: string;
  specialty: string;
}

export interface JoinInput {
  centerName: string;
  kind: string;
  person: 'natural' | 'legal' | '';
  city: string;
  fields: string[];
  address: string;
  managerName: string;
  mobile: string;
  doctors: JoinDoctor[];
  files: Record<string, { type: string; size: number } | undefined>;
  consent: boolean;
}

/** Persian and Arabic digits to ASCII, for the numbers typed in a Persian keyboard. */
export const asciiDigits = (s: string) =>
  s
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

/** A file's own problem, or null: its type and its size. */
export function fileProblem(file: { type: string; size: number }): string | null {
  if (!FILE_TYPES.includes(file.type)) return 'فقط PDF، JPG یا PNG.';
  if (file.size > MAX_FILE_BYTES) return 'حداکثر ۱۰ مگابایت.';
  return null;
}

/**
 * What is wrong with a request, by field name; empty when it may be sent. Checked again by
 * the API when the intake is built: this is for the person filling it in.
 */
export function joinProblems(input: JoinInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.centerName.trim().length < 3) out['centerName'] = 'نام مرکز یا مطب را بنویسید.';
  if (!input.kind) out['kind'] = 'نوع مرکز را انتخاب کنید.';
  if (!input.person) out['person'] = 'نوع شخص را انتخاب کنید.';
  if (!input.city) out['city'] = 'شهر را انتخاب کنید.';
  if (input.fields.length === 0) out['fields'] = 'دست‌کم یک رشته درمان را انتخاب کنید.';
  if (input.address.trim().length < 10) out['address'] = 'نشانی کامل را بنویسید.';
  if (input.managerName.trim().length < 3)
    out['managerName'] = 'نام و نام خانوادگی مسئول را بنویسید.';
  if (!normalizeMobile(asciiDigits(input.mobile)))
    out['mobile'] = 'شماره موبایل درست نیست؛ مانند ۰۹۱۲۳۴۵۶۷۸۹.';
  const named = input.doctors.filter((d) => d.name.trim() || d.council.trim());
  if (named.length === 0) out['doctors'] = 'دست‌کم یک پزشک را بنویسید.';
  input.doctors.forEach((d, i) => {
    if (!d.name.trim() && !d.council.trim()) return;
    if (d.name.trim().length < 3) out[`doctor-${String(i)}-name`] = 'نام پزشک را بنویسید.';
    if (!/^\d{3,7}$/.test(asciiDigits(d.council.trim())))
      out[`doctor-${String(i)}-council`] = 'شماره نظام پزشکی ۳ تا ۷ رقم است.';
  });
  for (const doc of DOCUMENTS) {
    const file = input.files[doc.key];
    if (doc.legalOnly && input.person !== 'legal') continue;
    if (!file) {
      if (doc.required) out[`file-${doc.key}`] = `${doc.label} را بارگذاری کنید.`;
      continue;
    }
    const problem = fileProblem(file);
    if (problem) out[`file-${doc.key}`] = problem;
  }
  if (!input.consent) out['consent'] = 'برای ارسال، درستی اطلاعات را تأیید کنید.';
  return out;
}
