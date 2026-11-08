import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { STACK, STACK_DIR } from '../src/stack-config.ts';
import { fixture, newMobile, otpFor, patientLogin, staffPage } from './support.ts';

/**
 * The owner's visual approval of the pages of 1405/07/26 (ف۱۲): the patient's own mobile
 * change (ب۱) and the internal panel's two-person change of a lost mobile (ب۲). Never part of
 * the acceptance run: only with VISUAL=1. Saved to VISUAL_OUT (outside the repository), else
 * .stack/visual-owner. Nothing is changed beyond what patient-mobile-change.spec does.
 */
const OUT = process.env['VISUAL_OUT'] ?? resolve(STACK_DIR, 'visual-owner');
const PHONE = { width: 390, height: 844 };

const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots for the owner (1405/07/26)', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const [one, two] = fixture().mobileChangers;
  if (!one || !two) throw new Error('the seed has two holders of identity.change_patient_mobile');

  // ب1: the patient's page, its code step and its end; and on a phone.
  const patient = await (await browser.newContext({ baseURL: STACK.webUrl })).newPage();
  await patient.goto(`/login?next=${encodeURIComponent('/me/mobile')}`);
  await patientLogin(patient, newMobile());
  await expect(
    patient.getByRole('heading', { level: 1, name: 'تغییر شماره موبایل' }),
  ).toBeVisible();
  await shot(patient, 'p26-01-patient-mobile-form');
  const to = newMobile();
  await patient.getByLabel('شماره موبایل تازه').fill(`0${to}`);
  await patient.getByRole('button', { name: 'دریافت کد تأیید' }).click();
  await expect(patient.getByText('کد تأیید به شماره')).toBeVisible();
  await shot(patient, 'p26-02-patient-mobile-code');
  await patient.getByLabel('کد تأیید').fill(await otpFor(to));
  await patient.getByRole('button', { name: 'تأیید و تغییر شماره' }).click();
  await expect(patient.getByText('شماره موبایل تغییر کرد')).toBeVisible();
  await shot(patient, 'p26-03-patient-mobile-done');
  const phone = await (
    await browser.newContext({ baseURL: STACK.webUrl, viewport: PHONE })
  ).newPage();
  await phone.goto(`/login?next=${encodeURIComponent('/me/mobile')}`);
  await patientLogin(phone, newMobile());
  await expect(phone.getByRole('heading', { level: 1, name: 'تغییر شماره موبایل' })).toBeVisible();
  await shot(phone, 'p26-04-patient-mobile-phone');

  // ب2: the internal panel, empty; the first's code step; the queue as the second sees it.
  const from = newMobile();
  const lostTo = newMobile();
  const lost = await (await browser.newContext({ baseURL: STACK.webUrl })).newPage();
  await lost.goto(`/login?next=${encodeURIComponent('/me/appointments')}`);
  await patientLogin(lost, from);
  await expect(lost).toHaveURL(`${STACK.webUrl}/me/appointments`);
  const first = await staffPage(browser, one, STACK.adminUrl, '/login', '/patient-mobile-changes');
  await expect(first.getByRole('heading', { level: 1, name: 'تغییر شماره بیمار' })).toBeVisible();
  await shot(first, 'p26-05-staff-change-empty');
  await first.getByLabel('شماره فعلی بیمار (گم‌شده)').fill(`0${from}`);
  await first.getByLabel('شماره تازه بیمار').fill(`0${lostTo}`);
  await first.getByRole('button', { name: 'ارسال کد به شماره تازه' }).click();
  await expect(first.getByText('آن را از بیمار بپرسید')).toBeVisible();
  await first.getByLabel('کدی که بیمار خواند').fill(await otpFor(lostTo));
  await first.getByLabel('مدرکی که دیدید').fill('کارت ملی حضوری در شعبه');
  await first.getByLabel('دلیل').fill('گوشی بیمار گم شده است');
  await shot(first, 'p26-06-staff-change-code');
  await first.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(first.getByText('پیشنهاد ثبت شد و منتظر تأیید همکار دیگر است.')).toBeVisible();
  await shot(first, 'p26-07-staff-change-proposed');
  const second = await staffPage(browser, two, STACK.adminUrl, '/login', '/patient-mobile-changes');
  await expect(second.getByRole('button', { name: 'تأیید نفر دوم' }).first()).toBeVisible();
  await shot(second, 'p26-08-staff-change-second');
  await second.getByRole('button', { name: 'تأیید نفر دوم' }).first().click();
  await expect(second.getByText('با تأیید، شماره ورود بیمار عوض می‌شود')).toBeVisible();
  await shot(second, 'p26-09-staff-change-approve');
  await second.setViewportSize(PHONE);
  await second.reload();
  await expect(second.getByRole('heading', { level: 1, name: 'تغییر شماره بیمار' })).toBeVisible();
  await shot(second, 'p26-10-staff-change-phone');
});
