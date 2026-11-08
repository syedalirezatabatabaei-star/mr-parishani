import { expect, test } from '@playwright/test';
import { fixture, newMobile, patientLogin, patientLoginAfterWait } from './support.ts';

/**
 * The patient's half of doc 09's path «جست‌وجو ← صفحه پزشک ← رزرو»: search, the public
 * page, signing in with a code, holding a time and requesting it, then seeing it in
 * «نوبت‌های من» waiting for the center.
 */
test('the search offers the active cities only, and finds the doctor there', async ({ page }) => {
  const { doctorName } = fixture();
  await page.goto('/search');
  const city = page.getByLabel('شهر');
  // The active cities only: Isfahan (migration 0020), Kashan and Shahin Shahr (0109, owner
  // 1405/08/09), in their order.
  await expect(city.locator('option')).toHaveText(['همه شهرها', 'اصفهان', 'کاشان', 'شاهین‌شهر']);
  await city.selectOption({ label: 'اصفهان' });
  await page.getByRole('button', { name: 'جست‌وجو', exact: true }).click();
  await expect(page).toHaveURL(/city=isfahan/);
  await expect(page.locator('article', { hasText: doctorName })).toContainText('اصفهان');
  // A city the network does not work in finds nothing.
  await page.goto('/search?city=tehran');
  await expect(page.getByText('پزشکی با این فیلترها پیدا نشد.')).toBeVisible();
});

test('search → doctor page → sign in → book → my appointments', async ({ page }) => {
  const { doctorName, centerName } = fixture();

  await page.goto('/search');
  await page.getByLabel('نام پزشک، مرکز یا خدمت').fill('آفتاب');
  await page.getByRole('button', { name: 'جست‌وجو', exact: true }).click();
  await expect(page).toHaveURL(/q=/);
  const card = page.locator('article', { hasText: doctorName });
  await expect(card).toBeVisible();
  await expect(card).toContainText(centerName);
  await expect(card).toContainText('اصفهان');

  await card.getByRole('link', { name: doctorName }).click();
  await expect(page.getByRole('heading', { level: 1, name: doctorName })).toBeVisible();
  await page.getByRole('link', { name: 'انتخاب زمان و نوبت' }).first().click();

  // Booking is for signed-in patients: the sign-in comes first, then back to booking.
  await expect(page).toHaveURL(/\/login\?next=%2Fbook%2F/);
  await patientLogin(page, newMobile());
  await expect(page).toHaveURL(/\/book\//);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(doctorName);

  // The first day with free times, then its first time.
  const calendar = page.getByRole('group', { name: 'روز و ساعت نوبت' });
  const day = calendar
    .locator('[role="grid"] button[aria-label*="ظرفیت"]:not([aria-disabled="true"])')
    .first();
  await day.click();
  const times = page.getByRole('group', { name: /^زمان‌های/ });
  await times.getByRole('button').first().click();

  await expect(page.getByRole('heading', { name: 'بررسی و ثبت نوبت' })).toBeVisible();
  await expect(page.getByText('دیگر برای شما نگه داشته می‌شود')).toBeVisible();
  await page.getByRole('button', { name: 'ثبت درخواست نوبت' }).click();
  await expect(page.getByText('درخواست نوبت ثبت شد')).toBeVisible();

  await page.getByRole('link', { name: 'نوبت‌های من' }).last().click();
  const mine = page.getByRole('list', { name: 'فهرست نوبت‌ها' });
  await expect(mine.getByRole('listitem')).toHaveCount(1);
  await expect(mine).toContainText(doctorName);
  await expect(mine).toContainText('در انتظار تأیید مرکز');
});

test('a session the server ended: to sign in again and back, not a failed page', async ({
  page,
  context,
}) => {
  // Owner 1405/08/09: a cookie the API no longer takes (a reset database, the 12 hours) once
  // showed «زمان‌های آزاد خوانده نشد» on the booking page; now every patient page signs in again.
  const { workplaceId } = fixture();
  const mobile = newMobile();
  await page.goto('/me/repayment');
  await expect(page).toHaveURL(/\/login\?next=%2Fme%2Frepayment/);
  await patientLogin(page, mobile);
  await expect(page).toHaveURL(/\/me\/repayment/);

  // The server ends the session; the browser keeps its cookie.
  const old = (await context.cookies()).find((c) => c.name === '__Host-sid');
  expect(old).toBeDefined();
  const ended = await page.evaluate(async () => {
    const me = (await (await fetch('/api/v1/auth/me')).json()) as { csrfToken: string };
    const out = await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': me.csrfToken },
    });
    return out.status;
  });
  expect(ended).toBe(204);
  if (old) await context.addCookies([old]);

  for (const path of [`/book/${workplaceId}`, '/me/repayment', '/me/contracts', '/me/credit']) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path)}$`));
  }
  await expect(page.getByText('زمان‌های آزاد خوانده نشد')).toHaveCount(0);

  // Signed in again from the booking page: back on it, with its free times.
  await page.goto(`/book/${workplaceId}`);
  await patientLoginAfterWait(page, mobile);
  await expect(page).toHaveURL(new RegExp(`/book/${workplaceId}$`));
  await expect(page.getByRole('group', { name: 'روز و ساعت نوبت' })).toBeVisible();
});
