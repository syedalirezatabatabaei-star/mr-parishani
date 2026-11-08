import { expect, test } from '@playwright/test';
import {
  chooseWorkplace,
  fixture,
  newMobile,
  nonJalaliDates,
  patientLogin,
  staffLogin,
} from './support.ts';

/**
 * Doc 09's acceptance path for 2-11, whole: «جست‌وجو ← صفحه پزشک ← رزرو ← تأیید مرکز ←
 * پذیرش». The patient books from the public pages; the center manager, signed in with
 * password and TOTP, approves the request; the patient then sees the confirmation and the
 * check-in code; the manager receives the patient with that code.
 */
test('search → doctor page → booking → center approval → check-in', async ({ browser }) => {
  const { doctorName, manager } = fixture();
  const mobile = newMobile();
  const masked = `۰${mobile.slice(0, 3)}***${mobile.slice(-4)}`.replace(/\d/g, (d) =>
    String.fromCharCode(0x06f0 + Number(d)),
  );

  // The patient: search, the doctor's page, sign in, book.
  const patient = await (await browser.newContext()).newPage();
  await patient.goto('/search?q=' + encodeURIComponent('آفتاب'));
  await patient
    .locator('article', { hasText: doctorName })
    .getByRole('link', { name: doctorName })
    .click();
  await expect(patient.getByRole('heading', { level: 1, name: doctorName })).toBeVisible();
  await patient.getByRole('link', { name: 'انتخاب زمان و نوبت' }).first().click();
  await patientLogin(patient, mobile);
  await expect(patient).toHaveURL(/\/book\//);
  await patient
    .getByRole('group', { name: 'روز و ساعت نوبت' })
    .locator('[role="grid"] button[aria-label*="ظرفیت"]:not([aria-disabled="true"])')
    .first()
    .click();
  await patient
    .getByRole('group', { name: /^زمان‌های/ })
    .getByRole('button')
    .first()
    .click();
  await patient.getByRole('button', { name: 'ثبت درخواست نوبت' }).click();
  await expect(patient.getByText('درخواست نوبت ثبت شد')).toBeVisible();

  // The center manager: sign in to the panel, find the request, approve it.
  const staff = await (await browser.newContext()).newPage();
  await staff.goto('/panel/appointments');
  await expect(staff).toHaveURL(/\/panel\/login/);
  await staffLogin(staff, manager);
  await expect(staff).toHaveURL(/\/panel\/appointments/);
  // The center has more than one doctor: the manager picks this one.
  await chooseWorkplace(staff, doctorName, 'اعمال فیلتر');
  const row = staff.getByRole('row').filter({ hasText: masked });
  await expect(row).toContainText('در انتظار تأیید مرکز');
  await row.getByRole('button', { name: 'تأیید' }).click();
  await expect(row).toContainText('تأییدشده');

  // The patient sees the confirmation and the check-in code.
  await patient.goto('/me/appointments');
  const mine = patient.getByRole('list', { name: 'فهرست نوبت‌ها' }).getByRole('listitem').first();
  await expect(mine).toContainText('تأییدشده');
  const codeText = (await mine.getByText('کد پذیرش در مرکز').locator('span').textContent()) ?? '';
  expect(codeText).toMatch(/^[۰-۹]+$/);

  // At the center: the patient tells the code (in Persian digits), the manager receives them.
  await row.getByRole('button', { name: 'پذیرش' }).click();
  await row.getByLabel('کد پذیرش بیمار').fill(codeText);
  await row.getByRole('button', { name: 'پذیرش' }).click();
  await expect(row).toContainText('پذیرش‌شده');
  // The panel shows Jalali dates only, as every page does (ADR-011).
  expect(await nonJalaliDates(staff)).toEqual([]);

  await patient.reload();
  await expect(mine).toContainText('پذیرش‌شده');
});

test('a wrong check-in code is refused and said plainly', async ({ browser }) => {
  const { manager } = fixture();
  const mobile = newMobile();
  const page = await (await browser.newContext()).newPage();
  const { workplaceId } = fixture();
  await page.goto(`/book/${workplaceId}`);
  await patientLogin(page, mobile);
  await page
    .getByRole('group', { name: 'روز و ساعت نوبت' })
    .locator('[role="grid"] button[aria-label*="ظرفیت"]:not([aria-disabled="true"])')
    .first()
    .click();
  await page
    .getByRole('group', { name: /^زمان‌های/ })
    .getByRole('button')
    .first()
    .click();
  await page.getByRole('button', { name: 'ثبت درخواست نوبت' }).click();
  await expect(page.getByText('درخواست نوبت ثبت شد')).toBeVisible();

  const staff = await (await browser.newContext()).newPage();
  await staff.goto(
    `/panel/login?next=${encodeURIComponent(`/panel/appointments?workplace=${workplaceId}`)}`,
  );
  await staffLogin(staff, manager);
  await expect(staff).toHaveURL(new RegExp(`workplace=${workplaceId}`));
  const masked = `۰${mobile.slice(0, 3)}***${mobile.slice(-4)}`.replace(/\d/g, (d) =>
    String.fromCharCode(0x06f0 + Number(d)),
  );
  const row = staff.getByRole('row').filter({ hasText: masked });
  await row.getByRole('button', { name: 'تأیید' }).click();
  await expect(row).toContainText('تأییدشده');
  await row.getByRole('button', { name: 'پذیرش' }).click();
  await row.getByLabel('کد پذیرش بیمار').fill('000000');
  await row.getByRole('button', { name: 'پذیرش' }).click();
  await expect(row.getByRole('alert')).toContainText('کد پذیرش درست نیست');
  await expect(row).toContainText('تأییدشده');
});
