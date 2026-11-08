import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { formatJalaliDate, toJalali } from '@sepehr/contracts';
import { STACK, STACK_DIR } from '../src/stack-config.ts';
import { fixture, staffPage, signedPost } from './support.ts';

/**
 * The owner's visual approval of round thirty-two's panel parts (1405/07/29, answers f and i):
 * the visit price page (proposed by one, the second person's queue, the decision), and the
 * formation deposit on a case's completion page (the form, then recorded). Only with VISUAL=1;
 * saved to VISUAL_OUT (outside the repository), else .stack/visual-owner-29b. The deposit's
 * amount is set in this throwaway database only, by two strategy managers through the API, as
 * the panel would.
 */
const OUT = process.env['VISUAL_OUT'] ?? resolve(STACK_DIR, 'visual-owner-29b');

const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
};

const csrf = async (page: Page) =>
  ((await (await page.request.get('/api/v1/auth/me')).json()) as { csrfToken: string }).csrfToken;

test.skip(process.env['VISUAL'] !== '1', 'screenshots only for the owner’s review (VISUAL=1)');

test('screenshots for the owner (1405/07/29, round thirty-two)', async ({ browser }) => {
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  const f = fixture();

  // 1. A visit price, proposed by one.
  const proposer = await staffPage(
    browser,
    f.specialist,
    STACK.adminUrl,
    '/login',
    '/visit-tariffs',
  );
  const form = proposer.getByRole('form', { name: 'پیشنهاد تعرفه ویزیت' });
  await form.getByLabel('پزشک و محل کار').selectOption(f.workplaceId);
  await form.getByLabel('کمینه (ریال)').fill('8000000');
  await form.getByLabel('بیشینه (ریال)').fill('10000000');
  await form.getByLabel('دلیل').fill('تعرفه ویزیت از فهرست الحاقیه مهر');
  await shot(proposer, 'p32-01-visit-tariff-proposal-form');
  await form.getByRole('button', { name: 'پیشنهاد (با تأیید نفر دوم)' }).click();
  await expect(form.getByText('پیشنهاد ثبت شد. نفر دوم باید آن را تأیید کند.')).toBeVisible();

  // 2. The second person's queue, then the decision.
  const second = await staffPage(
    browser,
    f.networkManager,
    STACK.adminUrl,
    '/login',
    '/visit-tariffs',
  );
  const row = second
    .getByRole('table', { name: /در انتظار تأیید/ })
    .getByRole('row', { name: /تعرفه ویزیت از فهرست الحاقیه مهر/ });
  await row.getByLabel('دلیل تصمیم').fill('با فهرست کارفرما یکی است');
  await shot(second, 'p32-02-visit-tariff-second-person-queue');
  await row.getByRole('button', { name: 'تأیید تعرفه' }).click();
  await expect(row).toHaveCount(0);
  await shot(second, 'p32-03-visit-tariff-decided');

  // 3. The deposit's amount, by two strategy managers (as the panel would).
  const a = await staffPage(browser, f.strategyA, STACK.adminUrl, '/login', '/settings');
  const made = await signedPost(a, '/api/v1/config/proposals', {
    headers: { 'x-csrf-token': await csrf(a), origin: STACK.adminUrl },
    data: {
      key: 'credit.formation_deposit_rial',
      scope: { level: 'global' },
      value: '990000',
      reason: 'تصویر برای تأیید بصری مالک (پایگاه دورریختنی)',
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const b = await staffPage(browser, f.strategyB, STACK.adminUrl, '/login', '/settings');
  const approved = await signedPost(
    b,
    `/api/v1/config/proposals/${((await made.json()) as { id: string }).id}/approve`,
    { headers: { 'x-csrf-token': await csrf(b), origin: STACK.adminUrl }, data: {} },
  );
  expect(approved.status(), await approved.text()).toBeLessThan(300);

  // 4. The deposit on a case's completion page: the form, then recorded.
  const completion = await staffPage(
    browser,
    f.completion,
    STACK.adminUrl,
    '/login',
    `/completion/${f.repaymentApplicationId}`,
  );
  const section = completion.getByRole('region', { name: /^بیعانه تشکیل/ });
  const deposit = section.getByRole('form', { name: 'ثبت بیعانه تشکیل' });
  const today = formatJalaliDate(toJalali(new Date()), { digits: 'latn' });
  await deposit.getByLabel('روز پرداخت بیعانه').fill(today);
  await deposit.getByLabel('روز پرداخت بیعانه').press('Enter');
  await deposit.getByLabel('شماره پیگیری بانک').fill('TRK-445566009876');
  await deposit.getByLabel('یادداشت (اختیاری)').fill('پرداخت در شعبه');
  await section.scrollIntoViewIfNeeded();
  await shot(completion, 'p32-04-formation-deposit-form');
  await deposit.getByRole('button', { name: 'ثبت بیعانه' }).click();
  await expect(section.getByText('…9876')).toBeVisible();
  await shot(completion, 'p32-05-formation-deposit-recorded');
});
