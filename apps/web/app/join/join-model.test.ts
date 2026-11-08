import { describe, expect, it } from 'vitest';
import { asciiDigits, fileProblem, joinProblems, type JoinInput } from './join-model';

const PDF = { type: 'application/pdf', size: 200_000 };

const valid = (over: Partial<JoinInput> = {}): JoinInput => ({
  centerName: 'کلینیک چشم پارسیان',
  kind: 'clinic',
  person: 'natural',
  city: 'isfahan',
  fields: ['eye'],
  address: 'اصفهان، خیابان چهارباغ، پلاک ۱۲',
  managerName: 'مریم احمدی',
  mobile: '۰۹۱۲۳۴۵۶۷۸۹',
  doctors: [{ name: 'دکتر رضا کریمی', council: '۱۲۳۴۵', specialty: 'چشم' }],
  files: { license: PDF, owner_id: { type: 'image/jpeg', size: 1_000 } },
  consent: true,
  ...over,
});

describe('the centers’ request form (preview)', () => {
  it('takes a complete request typed with Persian digits', () => {
    expect(asciiDigits('۰۹۱۲٣')).toBe('09123');
    expect(joinProblems(valid())).toEqual({});
  });

  it('names each missing or wrong field in Persian', () => {
    const problems = joinProblems(
      valid({
        centerName: '',
        fields: [],
        mobile: '12345',
        doctors: [{ name: 'دکتر', council: '12', specialty: '' }],
        consent: false,
      }),
    );
    expect(problems).toEqual({
      centerName: 'نام مرکز یا مطب را بنویسید.',
      fields: 'دست‌کم یک رشته درمان را انتخاب کنید.',
      mobile: 'شماره موبایل درست نیست؛ مانند ۰۹۱۲۳۴۵۶۷۸۹.',
      'doctor-0-council': 'شماره نظام پزشکی ۳ تا ۷ رقم است.',
      consent: 'برای ارسال، درستی اطلاعات را تأیید کنید.',
    });
  });

  it('wants at least one doctor; empty rows are left out', () => {
    expect(joinProblems(valid({ doctors: [{ name: '', council: '', specialty: '' }] }))).toEqual({
      doctors: 'دست‌کم یک پزشک را بنویسید.',
    });
  });

  it('asks a legal person for the gazette too, and checks every file’s type and size', () => {
    expect(joinProblems(valid({ person: 'legal' }))).toEqual({
      'file-gazette': 'روزنامه رسمی آخرین تغییرات را بارگذاری کنید.',
    });
    expect(fileProblem({ type: 'application/zip', size: 10 })).toBe('فقط PDF، JPG یا PNG.');
    expect(fileProblem({ type: 'image/png', size: 11 * 1024 * 1024 })).toBe('حداکثر ۱۰ مگابایت.');
    expect(joinProblems(valid({ files: { license: PDF } }))).toEqual({
      'file-owner_id': 'کارت ملی مسئول را بارگذاری کنید.',
    });
  });
});
