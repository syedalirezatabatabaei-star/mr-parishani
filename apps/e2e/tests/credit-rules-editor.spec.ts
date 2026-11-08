import { expect, test, type Browser, type Page } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, staffPage } from './support.ts';

type Staff = ReturnType<typeof fixture>['strategyA'];

/**
 * The forms that replaced the JSON of the strategy manager's settings (owner 1405/08/10): the
 * scoring rules, the loan plans and the business keys that had no page. Each is proposed by one
 * strategy manager, approved by the other, and then in force. What changes here is undone, or
 * changes nothing the other specs read: an option's label (restored), a plan added off, a value
 * proposed as it already is.
 */

const open = (browser: Browser, who: Staff, path: string) =>
  staffPage(browser, who, STACK.adminUrl, '/login', path);

async function propose(page: Page, reason: string) {
  await page.getByRole('button', { name: 'نمایش تغییرات' }).click();
  const form = page.getByRole('form', { name: 'پیشنهاد مقدار تازه' });
  await form.getByLabel('دلیل تغییر').fill(reason);
  await form.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(
    form.getByText('پیشنهاد ثبت شد و منتظر تأیید مدیر استراتژی دیگری است.'),
  ).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(reason) })).toContainText(
    'پیشنهاد خودتان؛ منتظر نفر دوم',
  );
}

async function approve(page: Page, reason: string) {
  const row = page.getByRole('row', { name: new RegExp(reason) });
  await row.getByRole('button', { name: 'تأیید' }).click();
  await expect(page.getByRole('row', { name: new RegExp(reason) })).toContainText('جاری');
}

test('scoring rules: tables, a refused score, a label proposed, approved and in force', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { strategyA, strategyB } = fixture();
  const path = '/credit/rules?key=credit.scoring_ruleset';
  const a = await open(browser, strategyA, path);
  await expect(a.getByRole('heading', { level: 1, name: 'طرح‌ها و قواعد' })).toBeVisible();
  const tabs = a.getByRole('tablist', { name: 'بخش‌های قواعد امتیاز' });
  for (const name of ['وام‌گیرنده', 'ضامن', 'سطح مبلغ', 'مرجع تصمیم', 'ماتریس کفایت (فقط نمایش)']) {
    await expect(tabs.getByRole('tab', { name })).toBeVisible();
  }
  await expect(a.getByRole('region', { name: 'درباره این نسخه' })).toContainText('EXCEL-BUG');
  await checkPage(a);

  // Nothing typed: no change, nothing to send.
  await a.getByRole('button', { name: 'نمایش تغییرات' }).click();
  const form = a.getByRole('form', { name: 'پیشنهاد مقدار تازه' });
  await expect(form.getByText('تغییری نیست.')).toBeVisible();
  await expect(form.getByRole('button', { name: 'ثبت پیشنهاد' })).toBeDisabled();

  // A score that changes Excel's results: said in Persian, not sent.
  const label = a.getByLabel('برچسب official در شغل فعال و قابل احراز (وام‌گیرنده)');
  const was = await label.inputValue();
  const score = a.getByLabel('امتیاز official در شغل فعال و قابل احراز (وام‌گیرنده)');
  const scoreWas = await score.inputValue();
  await score.fill('۰');
  await a.getByRole('button', { name: 'نمایش تغییرات' }).click();
  await expect(form.getByRole('list', { name: 'تغییرات' })).toContainText(
    `امتیاز از ${scoreWas} به ۰`,
  );
  await expect(form.getByRole('list', { name: 'ایرادها' })).toContainText(
    'مورد نمونه فایل اکسل کارفرما',
  );
  await expect(form.getByRole('button', { name: 'ثبت پیشنهاد' })).toBeDisabled();
  await score.fill(scoreWas);

  // A label: proposed by one, approved by the other, then in force.
  await label.fill(`${was} (آزمون فرم)`);
  await propose(a, 'آزمون فرم قواعد امتیاز');
  const b = await open(browser, strategyB, path);
  await expect(b.getByRole('row', { name: /آزمون فرم قواعد امتیاز/ })).toContainText(
    `برچسب به «${was} (آزمون فرم)»`,
  );
  await approve(b, 'آزمون فرم قواعد امتیاز');
  await b.reload();
  await expect(b.getByLabel('برچسب official در شغل فعال و قابل احراز (وام‌گیرنده)')).toHaveValue(
    `${was} (آزمون فرم)`,
  );
  await b.getByRole('button', { name: 'نمایش JSON خام (فقط خواندنی)' }).click();
  await expect(b.getByLabel('JSON خام مقدار جاری')).toContainText(`${was} (آزمون فرم)`);

  // Put back, the same way: the other specs read the rules as they were.
  await b.getByLabel('برچسب official در شغل فعال و قابل احراز (وام‌گیرنده)').fill(was);
  await propose(b, 'بازگرداندن برچسب آزمون');
  await a.reload();
  await approve(a, 'بازگرداندن برچسب آزمون');
});

test('loan plans: a plan added in the form, previewed, proposed, approved and in force', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { strategyA, strategyB } = fixture();
  const path = '/credit/rules?key=credit.plans';
  const a = await open(browser, strategyA, path);
  const code = `e2e_${String(Date.now()).slice(-8)}`;
  const add = a.getByRole('form', { name: 'طرح تازه' });
  await add.getByLabel('کد طرح تازه').fill(code);
  await add.getByLabel('نام طرح تازه').fill('طرح آزمون فرم');
  await add.getByRole('button', { name: 'افزودن طرح (غیرفعال)' }).click();

  const plan = a.locator('details', { hasText: 'طرح آزمون فرم' });
  await plan.locator('summary').click();
  await expect(plan.getByText('پیش‌نمایش پس از رفع ایرادهای این طرح ساخته می‌شود.')).toBeVisible();
  // Persian digits and separators, as a person types them.
  await plan.getByRole('group', { name: 'رشته‌های درمان' }).getByRole('checkbox').first().check();
  await plan.getByLabel('کف مبلغ وام (ریال)').fill('۱۰٬۰۰۰٬۰۰۰');
  await plan.getByLabel('سقف مبلغ وام (ریال)').fill('۲٬۰۰۰٬۰۰۰٬۰۰۰');
  await plan.getByLabel('درصد', { exact: true }).first().fill('۱۵');
  await plan.getByRole('checkbox', { name: '۱۲ قسط' }).check();
  const preview = plan.getByRole('region', { name: 'پیش‌نمایش طرح آزمون فرم' });
  await expect(
    preview.getByRole('table', { name: 'جدول اقساط نمونه' }).getByRole('row'),
  ).toHaveCount(13);
  await expect(preview).toContainText('۱۵٬۰۰۰٬۰۰۰ تومان');
  await checkPage(a);

  await a.getByRole('button', { name: 'نمایش تغییرات' }).click();
  await expect(
    a.getByRole('form', { name: 'پیشنهاد مقدار تازه' }).getByRole('list', { name: 'تغییرات' }),
  ).toContainText(`طرح تازه «طرح آزمون فرم» (${code})`);
  await propose(a, 'آزمون فرم طرح‌ها');

  const b = await open(browser, strategyB, path);
  await approve(b, 'آزمون فرم طرح‌ها');
  await b.reload();
  await expect(b.locator('details', { hasText: 'طرح آزمون فرم' }).locator('summary')).toContainText(
    'غیرفعال',
  );
});

test('business keys without a page: typed, refused out of range, proposed and approved', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { strategyA, strategyB } = fixture();
  const path = '/business-settings?key=repayment.cancellation_penalty_due_days';
  const a = await open(browser, strategyA, path);
  await expect(
    a.getByRole('heading', { level: 1, name: 'تنظیمات اقساط، چک و تسویه' }),
  ).toBeVisible();
  const region = a.getByRole('region', { name: 'مهلت پرداخت خسارت انصراف (روز)' });
  const shown = (await region.getByText(/^مقدار جاری:/).innerText()).replace('مقدار جاری: ', '');
  const days = shown.replace(' روز', '');
  const form = a.getByRole('form', { name: 'پیشنهاد مقدار تازه' });
  await form.getByLabel('تعداد روز تازه').fill('۴۰۰');
  await form.getByLabel('دلیل تغییر').fill('آزمون مهلت خسارت');
  await form.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(form.getByText('یک عدد صحیح از ۱ تا ۳۶۵ بنویسید.')).toBeVisible();
  // The value it already has: approved and in force, nothing else changes.
  await form.getByLabel('تعداد روز تازه').fill(days);
  await form.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(form.getByText('پیشنهاد ثبت شد و منتظر تأیید نفر دوم است.')).toBeVisible();
  await checkPage(a);

  const b = await open(browser, strategyB, path);
  await approve(b, 'آزمون مهلت خسارت');
  await b.reload();
  await expect(b.getByRole('region', { name: 'مهلت پرداخت خسارت انصراف (روز)' })).toContainText(
    `مقدار جاری: ${shown}`,
  );

  // The penalty's ceiling is the owner's 18%.
  const penalty = await open(
    browser,
    strategyA,
    '/business-settings?key=repayment.cancellation_penalty_bps',
  );
  const penaltyForm = penalty.getByRole('form', { name: 'پیشنهاد مقدار تازه' });
  await penaltyForm.getByLabel('درصد تازه').fill('۲۰');
  await penaltyForm.getByLabel('دلیل تغییر').fill('آزمون سقف خسارت');
  await penaltyForm.getByRole('button', { name: 'ثبت پیشنهاد' }).click();
  await expect(penaltyForm.getByText('درصد باید از ۰ تا ۱۸ باشد.')).toBeVisible();
});
