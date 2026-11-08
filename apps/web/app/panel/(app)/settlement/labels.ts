import { JALALI_MONTH_NAMES, toJalali, toPersianDigits } from '@sepehr/contracts';

/** A Jalali month: «آبان ۱۴۰۵». */
export const monthName = (year: number, month: number) =>
  `${JALALI_MONTH_NAMES[month - 1] ?? ''} ${toPersianDigits(String(year))}`;

/** The Jalali month of an instant in Tehran. */
export const monthOf = (at: string) => {
  const j = toJalali(new Date(at));
  return monthName(j.year, j.month);
};

export const ITEM_KIND = {
  credit_service: 'خدمت اعتباری',
  credit_fee: 'کارمزد خدمت اعتباری',
  cash_fee: 'کارمزد خدمت نقدی',
} as const;
