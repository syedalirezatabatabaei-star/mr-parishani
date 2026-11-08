import { addJalaliDays, formatJalaliDate, toJalali } from '@sepehr/contracts';
import { expect, test, type Page } from '@playwright/test';
import { fixture, newMobile, nonJalaliDates, patientLogin } from './support.ts';

/**
 * ADR-011 and the owner's decision (1405/07/08–09): only Jalali dates are shown, on every
 * page, read aloud too; dates may still be typed in Persian, Arabic or English digits.
 */
const JALALI_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

const jalaliOnly = async (page: Page, where: string) => {
  expect(await nonJalaliDates(page), where).toEqual([]);
};

test('no Gregorian or Hijri date on the patient pages and the public doctor page', async ({
  page,
}) => {
  const { profileSlug, workplaceId } = fixture();
  for (const path of ['/', '/search', `/doctors/${profileSlug}`, '/login']) {
    await page.goto(path);
    await jalaliOnly(page, path);
  }

  // Signed in: the booking calendar with a day's times, the review, «نوبت‌های من».
  await page.goto(`/book/${workplaceId}`);
  await patientLogin(page, newMobile());
  await expect(page).toHaveURL(/\/book\//);
  const day = page
    .getByRole('group', { name: 'روز و ساعت نوبت' })
    .locator('[role="grid"] button[aria-label*="ظرفیت"]:not([aria-disabled="true"])')
    .first();
  await day.click();
  await jalaliOnly(page, 'booking calendar');
  // The month and year lists of the picker too. The month shown is read from the picker, not
  // fixed: the first free day may fall in any month (it failed on 1405/08/01 expecting مهر).
  const picker = page.getByRole('button', { name: /^انتخاب ماه و سال، / });
  const shownMonth = /^انتخاب ماه و سال، (\S+) /.exec(
    (await picker.getAttribute('aria-label')) ?? '',
  )?.[1];
  expect(JALALI_MONTHS, 'the month the picker shows').toContain(shownMonth);
  await picker.click();
  await jalaliOnly(page, 'month list');
  await page.getByRole('button', { name: /^انتخاب سال/ }).click();
  await jalaliOnly(page, 'year list');
  // Escape goes back a level at a time: years, then months, then the days.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: /^ماه‌های/ })).toBeVisible();
  await expect(page.getByRole('button', { name: shownMonth ?? '', pressed: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: /^زمان‌های/ })).toBeVisible();

  await page
    .getByRole('group', { name: /^زمان‌های/ })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'بررسی و ثبت نوبت' })).toBeVisible();
  await jalaliOnly(page, 'review');
  await page.getByRole('button', { name: 'ثبت درخواست نوبت' }).click();
  await expect(page.getByText('درخواست نوبت ثبت شد')).toBeVisible();
  await jalaliOnly(page, 'booked');
  await page.goto('/me/appointments?when=');
  await jalaliOnly(page, 'my appointments');
});

// Ten days from today in Jalali: the search takes no day before today, so a fixed date would
// fail once it passed (it did on 1405/07/21).
const day = addJalaliDays(toJalali(new Date()), 10);
const latin = formatJalaliDate(day, { digits: 'latn' });
const persian = formatJalaliDate(day);
const arabic = latin.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const inAddress = new RegExp(`freeBy=${latin.replaceAll('/', '-')}`);

for (const [digits, typed] of [
  ['English', latin],
  ['Arabic', arabic],
  ['Persian', persian],
] as const) {
  test(`a date typed in ${digits} digits is taken, and shown and kept in Jalali`, async ({
    page,
  }) => {
    await page.goto('/search');
    const field = page.getByLabel('زمان آزاد تا');
    await field.fill(typed);
    await field.press('Enter');
    await expect(field).toHaveValue(persian);
    await page.getByRole('button', { name: 'جست‌وجو', exact: true }).click();
    // The address holds the Jalali day too (ASCII digits), never a Gregorian one.
    await expect(page).toHaveURL(inAddress);
    await jalaliOnly(page, `search by ${digits} digits`);
  });
}

test('the check itself finds Gregorian and Hijri dates, in text and in accessible names', async ({
  page,
}) => {
  // A masked ID or a code with four digits is not a date.
  await page.setContent(
    '<main><p>۸ مهر ۱۴۰۵، ساعت ۰۹:۳۰</p><p>۱۴۰۵/۰۷/۰۸</p><p>شناسه ***۱۹۲۹</p><p>کد ۲۰۲۶</p></main>',
  );
  expect(await nonJalaliDates(page)).toEqual([]);
  await page.setContent(
    `<main>
      <p>2026-09-30</p>
      <button aria-label="۳۰سپتامبر">x</button>
      <p>رمضان‌ها</p>
      <p>۸ ربیع‌الاول ۱۴۴۸</p>
      <p>۱۴۴۸/۰۳/۰۸</p>
      <p>30/09/2026</p>
      <p>سال ۲۰۲۶</p>
      <p>1998 میلادی</p>
    </main>`,
  );
  const found = await nonJalaliDates(page);
  // Glued to digits it is still a month; inside a longer word («رمضان‌ها») it is not.
  expect(found.filter((f) => f.includes('رمضان'))).toEqual([]);
  expect(found).toEqual(
    expect.arrayContaining([
      'month name «سپتامبر»',
      'month name «ربیع‌الاول»',
      'date 2026-09-30',
      'date 1448/03/08',
      'day-first date 30/09/2026',
      'Gregorian year 2026',
      'Gregorian year 1998',
    ]),
  );
});
