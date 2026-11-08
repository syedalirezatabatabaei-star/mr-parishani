import { expect, test, type Page } from '@playwright/test';
import { formatJalaliDate, fromJalali, parseJalaliDate, toJalali } from '@sepehr/contracts';
import { CONTROL_URL, STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, patientLoginAfterWait, staffPage } from './support.ts';

/** The collection unit's nightly cycle (6-7), as of a moment, through the stack's control. */
async function cycleAt(at: Date) {
  const res = await fetch(
    `${CONTROL_URL}/collection-cycle?at=${encodeURIComponent(at.toISOString())}`,
    {
      method: 'POST',
    },
  );
  expect(res.status, await res.text()).toBe(200);
}

/** Noon in Tehran, `days` after a Jalali day as the page writes it. */
function after(jalali: string, days: number): Date {
  const day = parseJalaliDate(jalali);
  if (!day) throw new Error(`not a Jalali day: ${jalali}`);
  return new Date(fromJalali(day, { hour: 12 }).getTime() + days * 86_400_000);
}

/** The due days of the borrower's installments, as their own page shows them. */
async function dueDays(page: Page): Promise<string[]> {
  const rows = page.getByRole('table', { name: 'اقساط' }).getByRole('row');
  const out: string[] = [];
  for (let i = 1; i <= 2; i += 1) out.push(await rows.nth(i).getByRole('cell').nth(1).innerText());
  return out;
}

const TREATMENT = /دندان|ویزیت|جرم‌گیری|درمان|پزشک|دکتر|کلینیک|مرکز/;

/**
 * Task 6-9 acceptance (doc 16): «معوق ← صف ← وعده ← شکست وعده ← اطلاع ضامن». The loan falls
 * overdue (the nightly cycle, as of later days); the agent finds it in the queue, opens the
 * case (no treatment, doctor or center anywhere), records a call and a promise; the next cycle
 * judges the promise broken and opens stage 2; the agent sends the guarantor's SMS by their own
 * decision; it is in the SMS record. Jalali only, no serious axe violation.
 */
test('overdue → queue → promise → broken promise → guarantor told', async ({ browser }) => {
  test.setTimeout(300_000);
  const f = fixture();
  const masked = `0${f.collectionPatientMobile}`;

  // The borrower's due days (their own page), then the cycle five days after the first.
  const borrower = await (await browser.newContext({ baseURL: STACK.webUrl })).newPage();
  await borrower.goto('/login?next=%2Fme%2Frepayment');
  await patientLoginAfterWait(borrower, f.collectionPatientMobile);
  const [firstDue, secondDue] = await dueDays(borrower);
  await cycleAt(after(firstDue ?? '', 5));

  // The queue: the agent's own, the loan among them; the case opens.
  const agent = await staffPage(
    browser,
    f.collectionAgent,
    STACK.adminUrl,
    '/login',
    '/collection',
  );
  const queue = agent.getByRole('table', { name: 'پرونده‌های معوق' });
  const row = queue
    .getByRole('row')
    .filter({ hasText: masked.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d) });
  await expect(row).toBeVisible();
  await checkPage(agent);
  await row.getByRole('link').first().click();
  await expect(agent).toHaveURL(/\/collection\/[0-9a-f-]{36}$/);
  expect(await agent.locator('main').innerText()).not.toMatch(TREATMENT);
  await checkPage(agent);

  // A call recorded, and a promise for today.
  const action = agent.getByRole('form', { name: 'ثبت اقدام' });
  await action.getByLabel('نتیجه').fill('پاسخ داد، قول پرداخت داد');
  await action.getByRole('button', { name: 'ثبت اقدام' }).click();
  await expect(agent.getByRole('table', { name: 'اقدام‌ها' })).toContainText('پاسخ داد');
  const promise = agent.getByRole('form', { name: 'ثبت وعده پرداخت' });
  await promise.getByLabel('مبلغ وعده').fill('1000000');
  await promise.getByLabel('روز وعده').fill(formatJalaliDate(toJalali(new Date())));
  await promise.getByLabel('روز وعده').press('Tab');
  await promise.getByRole('button', { name: 'ثبت وعده' }).click();
  const promises = agent.getByRole('table', { name: 'وعده‌های پرداخت' });
  await expect(promises).toContainText('باز');

  // The next cycle, after the second due day: the promise broken, stage 2 open.
  await cycleAt(after(secondDue ?? '', 5));
  await agent.reload();
  await expect(promises).toContainText('شکسته');
  const tasks = agent.getByRole('table', { name: 'کارها' });
  await expect(tasks).toContainText('وعده شکسته');
  const notice = tasks.getByRole('row').filter({ hasText: 'اطلاع به ضامن (مرحله ۲)' });
  await expect(notice).toBeVisible();

  // The guarantor is told only by the agent's decision.
  await notice.getByRole('button', { name: 'ارسال پیامک ضامن' }).click();
  await notice.getByLabel('دلیل').fill('دو قسط معوق و وعده شکسته');
  await notice.getByRole('button', { name: 'ارسال' }).click();
  await expect(notice).toContainText('انجام‌شده');
  await expect(agent.getByRole('table', { name: 'اقدام‌ها' })).toContainText('تماس با ضامن');
  expect(await agent.locator('main').innerText()).not.toMatch(TREATMENT);
  await checkPage(agent);

  // In the SMS record: the guarantor's template, to the guarantor's mobile (masked).
  const support = await staffPage(browser, f.support, STACK.adminUrl, '/login', '/sms');
  const sent = support
    .getByRole('table', { name: 'پیامک‌های اخیر' })
    .getByRole('row')
    .filter({ hasText: 'repayment.guarantor_notice' });
  await expect(sent.first()).toBeVisible();
  await checkPage(support);
});
