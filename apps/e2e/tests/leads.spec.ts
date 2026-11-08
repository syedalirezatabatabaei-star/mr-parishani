import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, newMobile, staffPage } from './support.ts';

/**
 * The advisor's pages (owner 1405/07/24, go-live blocker م۹): a lead entered by hand lands in
 * the advisor's own cases; advising starts; an appointment is booked for the patient by
 * their mobile, and the case lists it.
 */
test('an advisor enters a lead, advises and books for the patient', async ({ browser }) => {
  test.setTimeout(240_000);
  const { advisor, doctorName } = fixture();
  const page = await staffPage(browser, advisor, STACK.adminUrl, '/login', '/leads');
  await expect(page.getByRole('heading', { level: 1, name: 'سرنخ‌ها و پرونده‌ها' })).toBeVisible();

  const mobile = newMobile();
  const intake = page.getByRole('region', { name: 'ثبت سرنخ' });
  await intake.getByLabel('موبایل').fill(`0${mobile}`);
  await intake.getByLabel('نام', { exact: true }).fill('بیمار مشاوره آزمون');
  await intake.getByLabel('رشته درمان').selectOption('dental');
  await intake.getByLabel('شهر').selectOption('isfahan');
  await intake.getByRole('button', { name: 'ثبت سرنخ' }).click();
  await expect(intake.getByText('سرنخ تازه.')).toBeVisible();
  await checkPage(page);

  await intake.getByRole('link', { name: 'باز کردن پرونده' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'بیمار مشاوره آزمون' })).toBeVisible();
  const person = page.getByRole('region', { name: 'شخص و وضعیت' });
  await expect(person.getByText('تازه', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'شروع مشاوره' }).click();
  await expect(person.getByText('در حال مشاوره', { exact: true })).toBeVisible();
  await checkPage(page);

  await page.getByRole('link', { name: 'نوبت برای بیمار' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'نوبت برای بیمار' })).toBeVisible();
  await page.getByRole('button', { name: 'جست‌وجو' }).click();
  const doctors = page.getByRole('list', { name: 'پزشکان' });
  await doctors
    .getByRole('listitem')
    .filter({ hasText: doctorName })
    .first()
    .getByRole('button', { name: 'انتخاب' })
    .click();
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
  await expect(page.getByRole('heading', { name: 'بررسی و ثبت نوبت' })).toBeVisible();
  await page.getByRole('button', { name: 'ثبت درخواست نوبت' }).click();
  await expect(page.getByText(/درخواست نوبت ثبت شد|نوبت تأیید شد/)).toBeVisible();

  await page.getByRole('link', { name: 'بازگشت به پرونده' }).click();
  await expect(page.getByRole('table', { name: 'نوبت‌های این پرونده' })).toContainText(
    /در انتظار تأیید مرکز|تأییدشده/,
  );
  await checkPage(page);
});

/**
 * Handing a case over (owner 1405/07/24: only the strategy manager): from the case page, by
 * the agent's username, with a reason. The advisor (own scope) no longer finds it.
 */
test('the strategy manager hands an advisor’s case to another agent', async ({ browser }) => {
  test.setTimeout(180_000);
  const { advisor, strategyA, support } = fixture();
  const page = await staffPage(browser, advisor, STACK.adminUrl, '/login', '/leads');
  const intake = page.getByRole('region', { name: 'ثبت سرنخ' });
  await intake.getByLabel('موبایل').fill(`0${newMobile()}`);
  await intake.getByLabel('نام', { exact: true }).fill('بیمار انتقال آزمون');
  await intake.getByLabel('رشته درمان').selectOption('dental');
  await intake.getByLabel('شهر').selectOption('isfahan');
  await intake.getByRole('button', { name: 'ثبت سرنخ' }).click();
  await intake.getByRole('link', { name: 'باز کردن پرونده' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'بیمار انتقال آزمون' })).toBeVisible();
  const casePath = new URL(page.url()).pathname;
  // The advisor may not hand over.
  await expect(page.getByRole('region', { name: 'انتقال به کارشناس دیگر' })).toHaveCount(0);

  const manager = await staffPage(browser, strategyA, STACK.adminUrl, '/login', casePath);
  const handOff = manager.getByRole('region', { name: 'انتقال به کارشناس دیگر' });
  await handOff.getByLabel('نام کاربری کارشناس').fill(support.username);
  await handOff.getByLabel('دلیل').fill('مرخصی مشاور، آزمون انتقال');
  await handOff.getByRole('button', { name: 'انتقال' }).click();
  await expect(handOff.getByText(/^پرونده به .+ منتقل شد\.$/)).toBeVisible();
  await checkPage(manager);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'بیمار انتقال آزمون' })).toHaveCount(0);
});

/**
 * The strategy manager's tools on the advisor's pages (doc 05 §5 and the intake table): the
 * abandonment reasons, each change with a reason; and blocking a person, then unblocking.
 */
test('the strategy manager edits the closing reasons and blocks a person', async ({ browser }) => {
  test.setTimeout(180_000);
  const { advisor, strategyA } = fixture();
  const page = await staffPage(browser, strategyA, STACK.adminUrl, '/login', '/leads');
  await page.getByRole('link', { name: 'علت‌های بستن پرونده' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'علت‌های بستن پرونده' })).toBeVisible();
  const code = `e2e_${String(Date.now()).slice(-8)}`;
  const reasons = page.getByRole('table', { name: 'علت‌های جاری' });

  const add = page.getByRole('region', { name: 'علت تازه' });
  await add.getByLabel('کد (لاتین)').fill(code);
  await add.getByLabel('عنوان', { exact: true }).fill('علت آزمون');
  await add.getByLabel('ترتیب').fill('۹۰۰۰');
  await add.getByLabel('دلیل').fill('آزمون صفحه علت‌ها');
  await add.getByRole('button', { name: 'افزودن علت' }).click();
  await expect(reasons.getByRole('row').filter({ hasText: code })).toContainText('علت آزمون');

  const edit = page.getByRole('region', { name: 'ویرایش علت' });
  await edit.getByLabel('علت').selectOption(code);
  await edit.getByLabel('عنوان تازه').fill('علت آزمون ویرایش‌شده');
  await edit.getByLabel('دلیل').fill('آزمون ویرایش');
  await edit.getByRole('button', { name: 'ثبت ویرایش' }).click();
  await expect(reasons.getByRole('row').filter({ hasText: code })).toContainText(
    'علت آزمون ویرایش‌شده',
  );

  const retire = page.getByRole('region', { name: 'کنار گذاشتن علت' });
  await expect(retire.getByRole('option', { name: /chose_cash/ })).toHaveCount(0);
  await retire.getByLabel('علت').selectOption(code);
  await retire.getByLabel('دلیل').fill('آزمون کنار گذاشتن');
  await retire.getByRole('button', { name: 'کنار گذاشتن' }).click();
  await expect(reasons.getByRole('row').filter({ hasText: code })).toHaveCount(0);
  await checkPage(page);

  // The advisor has neither the link nor the tools.
  const own = await staffPage(browser, advisor, STACK.adminUrl, '/login', '/leads');
  await expect(own.getByRole('link', { name: 'علت‌های بستن پرونده' })).toHaveCount(0);
  const intake = own.getByRole('region', { name: 'ثبت سرنخ' });
  await intake.getByLabel('موبایل').fill(`0${newMobile()}`);
  await intake.getByLabel('نام', { exact: true }).fill('بیمار مسدودی آزمون');
  await intake.getByLabel('رشته درمان').selectOption('dental');
  await intake.getByLabel('شهر').selectOption('isfahan');
  await intake.getByRole('button', { name: 'ثبت سرنخ' }).click();
  await intake.getByRole('link', { name: 'باز کردن پرونده' }).click();
  await expect(own.getByRole('heading', { level: 1, name: 'بیمار مسدودی آزمون' })).toBeVisible();
  await expect(own.getByRole('region', { name: 'مسدود کردن شخص' })).toHaveCount(0);

  const manager = await staffPage(
    browser,
    strategyA,
    STACK.adminUrl,
    '/login',
    new URL(own.url()).pathname,
  );
  const person = manager.getByRole('region', { name: 'شخص و وضعیت' });
  const block = manager.getByRole('region', { name: 'مسدود کردن شخص' });
  await block.getByLabel('نوع').selectOption('do_not_contact');
  await block.getByLabel('دلیل').fill('درخواست عدم تماس، آزمون');
  await block.getByRole('button', { name: 'مسدود کردن' }).click();
  await expect(person.getByText('مسدود', { exact: true })).toBeVisible();
  const unblock = manager.getByRole('region', { name: 'رفع مسدودی شخص' });
  await unblock.getByLabel('دلیل').fill('رفع مسدودی، آزمون');
  await unblock.getByRole('button', { name: 'رفع مسدودی' }).click();
  await expect(person.getByText('مسدود', { exact: true })).toHaveCount(0);
  await checkPage(manager);
});

/**
 * Merging a duplicate (doc 05 §9): from the survivor's case, the other case named by its
 * address; its case comes over; then the merge is undone. The advisor has no such section.
 */
test('the strategy manager merges a duplicate person, then undoes it', async ({ browser }) => {
  test.setTimeout(180_000);
  const { advisor, strategyA } = fixture();
  const page = await staffPage(browser, advisor, STACK.adminUrl, '/login', '/leads');
  const intake = page.getByRole('region', { name: 'ثبت سرنخ' });
  const enter = async (name: string) => {
    await intake.getByLabel('موبایل').fill(`0${newMobile()}`);
    await intake.getByLabel('نام', { exact: true }).fill(name);
    await intake.getByLabel('رشته درمان').selectOption('dental');
    await intake.getByLabel('شهر').selectOption('isfahan');
    await intake.getByRole('button', { name: 'ثبت سرنخ' }).click();
    await intake.getByRole('link', { name: 'باز کردن پرونده' }).click();
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    return page.url();
  };
  // The first is closed (two open cases are never merged), the second stays open.
  const first = await enter('بیمار ادغام اول');
  const close = page.getByRole('region', { name: 'بستن پرونده' });
  await close.getByLabel('علت').selectOption({ index: 0 });
  await close.getByRole('button', { name: 'بستن پرونده' }).click();
  await expect(page.getByRole('region', { name: 'بستن پرونده' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'ادغام شخص تکراری' })).toHaveCount(0);
  await page.goto(`${STACK.adminUrl}/leads`);
  const second = await enter('بیمار ادغام دوم');

  const manager = await staffPage(
    browser,
    strategyA,
    STACK.adminUrl,
    '/login',
    new URL(first).pathname,
  );
  const merge = manager.getByRole('region', { name: 'ادغام شخص تکراری' });
  await merge.getByLabel('نشانی یا شناسه پرونده تکراری').fill(second);
  await merge.getByLabel('دلیل ادغام').fill('یک نفر با دو موبایل، آزمون');
  await merge.getByRole('button', { name: 'ادغام در همین شخص' }).click();
  await expect(merge.getByText('ادغام شد؛ ۱ پرونده به این شخص آمد.')).toBeVisible();
  const merges = merge.getByRole('list', { name: 'ادغام‌های این شخص' });
  await expect(merges.getByRole('listitem')).toHaveCount(1);
  await checkPage(manager);

  // Its own case cannot be merged into itself.
  await merge.getByLabel('نشانی یا شناسه پرونده تکراری').fill(first);
  await merge.getByLabel('دلیل ادغام').fill('آزمون خطا');
  await merge.getByRole('button', { name: 'ادغام در همین شخص' }).click();
  await expect(merge.getByText('این پرونده مال همین شخص است.')).toBeVisible();

  await merges.getByLabel('دلیل برگشت').fill('ادغام اشتباه، آزمون');
  await merges.getByRole('button', { name: 'برگشت ادغام' }).click();
  await expect(merge.getByText('ادغام برگشت؛ ۱ پرونده برگشت.')).toBeVisible();
  await expect(merges.getByText(/برگشت خورده/)).toBeVisible();
  await expect(merges.getByRole('button', { name: 'برگشت ادغام' })).toHaveCount(0);
});
