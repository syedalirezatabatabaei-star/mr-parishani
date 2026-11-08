import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, staffPage } from './support.ts';

/**
 * The launch settings page (owner 1405/08/01–02, plan item الف): typed values, proposed by one
 * strategy manager and decided by the other. The cap is proposed and refused, so the shared
 * stack keeps it off for the specs after; the deposit is approved as admin.spec already set it.
 */
test('launch settings: a typed value proposed by one, refused or approved by another', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { strategyA, strategyB } = fixture();
  const page = (who: typeof strategyA, key: string) =>
    staffPage(browser, who, STACK.adminUrl, '/login', `/launch-settings?key=${key}`);

  // The cap, typed in Persian digits with separators: a preview, then a proposal.
  const proposer = await page(strategyA, 'credit.borrower_exposure_cap');
  await expect(
    proposer.getByRole('heading', { level: 1, name: 'تنظیمات راه‌اندازی' }),
  ).toBeVisible();
  const cap = proposer.getByRole('region', { name: 'سقف مانده فعال هر وام‌گیرنده (ریال)' });
  await expect(cap).toContainText('مقدار جاری: خاموش (۰)');
  await expect(cap).toContainText('بند ۲۰');
  const form = proposer.getByRole('form', { name: 'پیشنهاد مقدار تازه' });
  await form.getByLabel('سقف تازه (ریال)').fill('1.5');
  await form.getByLabel('دلیل تغییر').fill('آزمون سقف راه‌اندازی');
  await form.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(form.getByText('مبلغ را به ریال و بی اعشار بنویسید.')).toBeVisible();
  await form.getByLabel('سقف تازه (ریال)').fill('۱٬۵۰۰٬۰۰۰٬۰۰۰');
  await expect(form.getByText('یعنی: ۱٬۵۰۰٬۰۰۰٬۰۰۰ ریال (۱۵۰٬۰۰۰٬۰۰۰ تومان)')).toBeVisible();
  await form.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(form.getByText('پیشنهاد ثبت شد و منتظر تأیید نفر دوم است.')).toBeVisible();
  const mine = proposer.getByRole('row', { name: /آزمون سقف راه‌اندازی/ });
  await expect(mine).toContainText('پیشنهاد خودتان؛ منتظر نفر دوم');
  await checkPage(proposer);

  // The second strategy manager refuses it: the cap stays off.
  const second = await page(strategyB, 'credit.borrower_exposure_cap');
  const row = second.getByRole('row', { name: /آزمون سقف راه‌اندازی/ });
  await row.getByRole('button', { name: 'رد' }).click();
  await expect(second.getByRole('row', { name: /آزمون سقف راه‌اندازی/ })).toContainText('ردشده');
  await second.reload();
  await expect(
    second.getByRole('region', { name: 'سقف مانده فعال هر وام‌گیرنده (ریال)' }),
  ).toContainText('مقدار جاری: خاموش (۰)');

  // The deposit, approved by the other: 990,000 rials in force.
  const depositA = await page(strategyA, 'credit.formation_deposit_rial');
  const depositForm = depositA.getByRole('form', { name: 'پیشنهاد مقدار تازه' });
  await depositForm.getByLabel('مبلغ تازه (ریال)').fill('990000');
  await depositForm.getByLabel('دلیل تغییر').fill('آزمون بیعانه راه‌اندازی');
  await depositForm.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(depositForm.getByText('منتظر تأیید نفر دوم')).toBeVisible();
  const depositB = await page(strategyB, 'credit.formation_deposit_rial');
  await depositB
    .getByRole('row', { name: /آزمون بیعانه راه‌اندازی/ })
    .getByRole('button', { name: 'تأیید' })
    .click();
  await expect(depositB.getByRole('row', { name: /آزمون بیعانه راه‌اندازی/ })).toContainText(
    'جاری',
  );
  await depositB.reload();
  await expect(depositB.getByRole('region', { name: 'بیعانه تشکیل (ریال)' })).toContainText(
    '۹۹۰٬۰۰۰ ریال (۹۹٬۰۰۰ تومان)',
  );

  // The public search is a technical key: a strategy manager has no form for it.
  const search = await page(strategyA, 'catalog.search_enabled');
  await expect(search.getByRole('form', { name: 'پیشنهاد مقدار تازه' })).toHaveCount(0);
  await expect(search.getByText('فقط دارنده مجوز تنظیمات فنی')).toBeVisible();
});
