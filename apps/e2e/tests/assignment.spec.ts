import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, staffPage } from './support.ts';

/**
 * The strategy manager's assignment page (owner 1405/07/24): a new queue's shares set from
 * the panel with agents found by username, then presence and cap. A queue of its own, and
 * presence and cap set as they already are, so the other tests' queues are untouched.
 */
test('a queue shared between two agents, then their presence and cap', async ({ browser }) => {
  test.setTimeout(180_000);
  const { strategyA, support, collectionAgent } = fixture();
  const queue = `e2e_${String(Date.now()).slice(-8)}`;
  const page = await staffPage(
    browser,
    strategyA,
    STACK.adminUrl,
    '/login',
    `/assignment?other=${queue}`,
  );
  await expect(page.getByRole('heading', { level: 1, name: 'تخصیص سرنخ و پرونده' })).toBeVisible();
  await expect(page.getByText('این صف هنوز سهمی ندارد.')).toBeVisible();

  const editor = page.getByRole('region', { name: 'سهم‌های تازه' });
  for (const agent of [support, collectionAgent]) {
    await editor.getByLabel('نام کاربری کارشناس').fill(agent.username);
    await editor.getByRole('button', { name: 'افزودن کارشناس' }).click();
  }
  const percents = editor.getByRole('list', { name: 'سهم کارشناسان' }).getByRole('textbox');
  await expect(percents).toHaveCount(2);
  await percents.nth(0).fill('60');
  await percents.nth(1).fill('40');
  await expect(editor.getByText('جمع: ۱۰۰ از ۱۰۰')).toBeVisible();
  await editor.getByLabel('دلیل', { exact: true }).fill('تقسیم صف آزمون e2e');
  await editor.getByRole('button', { name: 'ثبت سهم‌ها' }).click();
  await expect(page.getByRole('table', { name: `سهم‌های جاری صف ${queue}` })).toContainText('۶۰٪');
  await checkPage(page);

  const presence = page.getByRole('form', { name: /^حضور / }).first();
  await presence.getByLabel('حضور', { exact: true }).selectOption('present');
  await presence.getByLabel('دلیل حضور').fill('حاضر، آزمون');
  await presence.getByRole('button', { name: 'ثبت حضور' }).click();
  await expect(page.getByText('حضور ثبت شد.')).toBeVisible();
  const cap = page.getByRole('form', { name: /^سقف / }).first();
  await cap.getByLabel('دلیل سقف').fill('بی‌سقف، آزمون');
  await cap.getByRole('button', { name: 'ثبت سقف' }).click();
  await expect(page.getByText('سقف ثبت شد.')).toBeVisible();
});
