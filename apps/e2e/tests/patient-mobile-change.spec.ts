import { expect, test, type Browser, type Page } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { fixture, newMobile, nextOtpFor, otpFor, patientLogin, staffPage } from './support.ts';

/**
 * ف۱۲ (owner 1405/07/26, option «ب»): a patient replaces their login mobile. ب۱: signed in,
 * on their own page, with the code sent to the new mobile. ب۲: the previous mobile lost, two
 * holders of identity.change_patient_mobile in the internal panel, the first with the code the
 * patient reads back, the second approving. Either way the new mobile then opens the same
 * account. The flag is on in this throwaway database only (seed).
 */

const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const fa = (digits: string) => digits.replace(/\d/g, (d) => PERSIAN[Number(d)] ?? d);

async function signedIn(browser: Browser, path: string) {
  const page = await (await browser.newContext({ baseURL: STACK.webUrl })).newPage();
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  return page;
}

const accountOf = async (page: Page) => {
  const res = await page.request.get('/api/v1/auth/me');
  return {
    status: res.status(),
    accountId: ((await res.json()) as { accountId?: string }).accountId,
  };
};

/** Sign-in with a mobile a code was sent to moments before (the change's): the next code. */
async function loginAfterChange(browser: Browser, mobile: string) {
  const previous = await otpFor(mobile);
  const page = await signedIn(browser, '/');
  await page.getByLabel('شماره موبایل').fill(`0${mobile}`);
  await page.getByRole('button', { name: 'دریافت کد ورود' }).click();
  await expect(page.getByText('کد ورود به شماره')).toBeVisible();
  await page.getByLabel('کد ورود').fill(await nextOtpFor(mobile, previous));
  await page.getByRole('button', { name: 'ورود', exact: true }).click();
  await expect(page).toHaveURL(`${STACK.webUrl}/`);
  return page;
}

test('ب1: a signed-in patient changes their mobile on their page, then signs in with it', async ({
  browser,
}) => {
  const from = newMobile();
  const to = newMobile();
  const page = await signedIn(browser, '/me/mobile');
  await patientLogin(page, from);
  await expect(page.getByRole('heading', { level: 1, name: 'تغییر شماره موبایل' })).toBeVisible();
  const before = await accountOf(page);
  expect(before.status).toBe(200);

  await page.getByLabel('شماره موبایل تازه').fill(`0${to}`);
  await page.getByRole('button', { name: 'دریافت کد تأیید' }).click();
  await expect(page.getByText('کد تأیید به شماره')).toBeVisible();
  await page.getByLabel('کد تأیید').fill(await otpFor(to));
  await page.getByRole('button', { name: 'تأیید و تغییر شماره' }).click();
  await expect(page.getByText('شماره موبایل تغییر کرد')).toBeVisible();
  await expect(page.getByText(fa(to.slice(-4)))).toBeVisible();

  const again = await loginAfterChange(browser, to);
  expect((await accountOf(again)).accountId).toBe(before.accountId);
});

test('ب2: the previous mobile lost, two staff change it; the patient is signed out and signs in with the new one', async ({
  browser,
}) => {
  const [one, two] = fixture().mobileChangers;
  if (!one || !two) throw new Error('the seed has two holders of identity.change_patient_mobile');
  const from = newMobile();
  const to = newMobile();
  const patient = await signedIn(browser, '/me/appointments');
  await patientLogin(patient, from);
  await expect(patient).toHaveURL(`${STACK.webUrl}/me/appointments`);
  const before = await accountOf(patient);
  expect(before.status).toBe(200);

  // The first: the code to the new mobile, read back by the patient, and the evidence seen.
  const first = await staffPage(browser, one, STACK.adminUrl, '/login', '/patient-mobile-changes');
  await expect(first.getByRole('heading', { level: 1, name: 'تغییر شماره بیمار' })).toBeVisible();
  await first.getByLabel('شماره فعلی بیمار (گم‌شده)').fill(`0${from}`);
  await first.getByLabel('شماره تازه بیمار').fill(`0${to}`);
  await first.getByRole('button', { name: 'ارسال کد به شماره تازه' }).click();
  await expect(first.getByText('آن را از بیمار بپرسید')).toBeVisible();
  await first.getByLabel('کدی که بیمار خواند').fill(await otpFor(to));
  await first.getByLabel('مدرکی که دیدید').fill('کارت ملی حضوری در شعبه');
  await first.getByLabel('دلیل').fill('گوشی بیمار گم شده است');
  await first.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(first.getByText('پیشنهاد ثبت شد و منتظر تأیید همکار دیگر است.')).toBeVisible();
  const mine = first.getByRole('row').filter({ hasText: fa(to.slice(-4)) });
  await expect(mine).toBeVisible();
  // Never the full number; the proposer cannot approve their own, only take it back.
  await expect(first.getByText(fa(to))).toHaveCount(0);
  await expect(mine.getByRole('button', { name: 'تأیید نفر دوم' })).toHaveCount(0);
  await expect(mine.getByRole('button', { name: 'پس گرفتن' })).toBeVisible();
  // Still the patient's session while it waits.
  expect((await accountOf(patient)).status).toBe(200);

  // The second approves.
  const second = await staffPage(browser, two, STACK.adminUrl, '/login', '/patient-mobile-changes');
  const row = second.getByRole('row').filter({ hasText: fa(to.slice(-4)) });
  await row.getByRole('button', { name: 'تأیید نفر دوم' }).click();
  await row.getByLabel('دلیل').fill('مدرک دیده شد');
  await row.getByRole('button', { name: 'تأیید', exact: true }).click();
  await expect(second.getByRole('row').filter({ hasText: fa(to.slice(-4)) })).toHaveCount(0);

  // Every session ended; the new mobile opens the same account.
  expect((await accountOf(patient)).status).toBe(401);
  const again = await loginAfterChange(browser, to);
  expect((await accountOf(again)).accountId).toBe(before.accountId);
});
