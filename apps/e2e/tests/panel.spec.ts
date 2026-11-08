import { expect, test } from '@playwright/test';
import { chooseWorkplace, fixture, menuNav, nonJalaliDates, staffLogin } from './support.ts';

/**
 * The center panel's pages (task 2-11, part 3), as the center manager: each loads with its
 * data and no error, shows Jalali dates only, and a new price typed in tomans is stored in
 * rials and shown back in tomans.
 */
test('the center manager: calendar, services and prices, staff, center', async ({ page }) => {
  const { manager, doctorName, centerName, workplaceId } = fixture();
  await page.goto('/panel/login?next=%2Fpanel');
  await staffLogin(page, manager);
  await expect(page.getByRole('heading', { level: 1, name: 'پیشخوان' })).toBeVisible();
  // The sections are in the ☰ menu (owner 1405/08/10).
  const nav = await menuNav(page, 'بخش‌های پنل');
  for (const section of [
    'نوبت‌ها',
    'تقویم کاری',
    'پزشکان و منشی‌ها',
    'خدمات و تعرفه',
    'مرکز و شعبه‌ها',
  ]) {
    await expect(nav.getByRole('link', { name: section })).toBeVisible();
  }

  const unexpected = page.getByText('خطای غیرمنتظره');

  await nav.getByRole('link', { name: 'تقویم کاری' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'تقویم کاری' })).toBeVisible();
  // The center has more than one doctor: the manager picks the one with hours.
  await chooseWorkplace(page, doctorName, 'نمایش');
  await expect(page.getByRole('heading', { level: 1, name: 'تقویم کاری' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ساعت‌های کاری هفته' })).toBeVisible();
  await expect(page.getByLabel('روز بازه ۱')).toHaveValue('saturday');
  // Times are shown in Persian digits, and saved as they are shown.
  await expect(page.getByLabel('شروع بازه ۱')).toHaveValue('۰۹:۰۰');
  await page.getByLabel('دلیل تغییر').last().fill('بازبینی ساعت‌ها');
  await page.getByRole('button', { name: 'ذخیره ساعت‌های کاری' }).click();
  await expect(page.getByText('ساعت‌های کاری ذخیره شد.')).toBeVisible();
  await expect(page.getByText('اکنون: دستی')).toBeVisible();
  await expect(page.getByRole('group', { name: 'زمان‌های آزاد محل کار' })).toBeVisible();
  await expect(unexpected).toHaveCount(0);
  expect(await nonJalaliDates(page), 'calendar').toEqual([]);

  await (await menuNav(page, 'بخش‌های پنل')).getByRole('link', { name: 'خدمات و تعرفه' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'خدمات و تعرفه' })).toBeVisible();
  // The doctor chosen on the calendar is still the one shown: the panel's links keep it.
  await expect(page).toHaveURL(/workplace=/);
  await expect(
    page.getByLabel('پزشک و محل', { exact: true }).locator('option:checked'),
  ).toContainText(doctorName);
  const prices = page.getByRole('table', { name: /^تعرفه‌های/ });
  // The visit's range in force as stored, in rials: the seed's (5,000,000 to 8,000,000), or a
  // version an earlier spec approved for this doctor (admin.spec's visit price). The row must
  // show that range in tomans, whichever spec ran first.
  const tariffs = (await (
    await page.request.get(`/api/v1/catalog/tariffs?workplaceId=${workplaceId}`)
  ).json()) as {
    serviceCode: string;
    current: { minAmountRial: string | null; maxAmountRial: string | null } | null;
  }[];
  const visit = tariffs.find((t) => t.serviceCode === 'visit')?.current;
  expect(visit?.minAmountRial, 'the visit price in force').toBeTruthy();
  expect(visit?.maxAmountRial, 'the visit price in force').toBeTruthy();
  const toman = (rial: string) =>
    `${new Intl.NumberFormat('fa-IR').format(BigInt(rial) / 10n)} تومان`;
  await expect(prices.getByRole('row', { name: /ویزیت/ })).toContainText(
    `${toman(visit?.minAmountRial ?? '0')} تا ${toman(visit?.maxAmountRial ?? '0')}`,
  );
  await page.getByLabel('از (ریال)').fill('۶٬۰۰۰٬۰۰۰');
  await page.getByLabel('تا (ریال)').fill('9000000');
  await page.getByLabel('دلیل', { exact: true }).fill('تعرفه سال جدید');
  await page.getByRole('button', { name: 'ثبت تعرفه' }).click();
  await expect(page.getByText('تعرفه ثبت شد.')).toBeVisible();
  await expect(prices.getByRole('row', { name: /ویزیت/ })).toContainText(
    '۶۰۰٬۰۰۰ تومان تا ۹۰۰٬۰۰۰ تومان',
  );
  expect(await nonJalaliDates(page), 'services').toEqual([]);

  await (
    await menuNav(page, 'بخش‌های پنل')
  )
    .getByRole('link', { name: 'پزشکان و منشی‌ها' })
    .click();
  await expect(page.getByText(doctorName, { exact: true })).toBeVisible();
  await expect(unexpected).toHaveCount(0);

  await (await menuNav(page, 'بخش‌های پنل')).getByRole('link', { name: 'مرکز و شعبه‌ها' }).click();
  await expect(page.getByRole('heading', { level: 2, name: centerName })).toBeVisible();
  await expect(page.getByText('فعال', { exact: true })).toBeVisible();
  await expect(page.getByRole('form', { name: /^شعبه/ })).toBeVisible();
  await expect(unexpected).toHaveCount(0);
  expect(await nonJalaliDates(page), 'center').toEqual([]);
});
