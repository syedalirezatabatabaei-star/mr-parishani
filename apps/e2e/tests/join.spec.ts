import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { nationalId } from '../src/synthetic.ts';
import {
  fixture,
  newMobile,
  otpFor,
  seriousA11yViolations,
  setupTokenFor,
  staffPage,
} from './support.ts';

/**
 * Owner 1405/08/10: the sign-in pages' frame, and the partnership request for real: the public
 * form with its SMS code and documents, the specialist's review, the manager's approval by
 * another person, the one-time link and the new manager's first sign-in.
 */
test('the sign-in pages: the brand side and the form, on a phone and a wide screen', async ({
  browser,
}) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(`${STACK.adminUrl}/login`);
    await expect(page.getByRole('heading', { level: 1, name: 'ورود به پنل داخلی' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'سپهر سلامتی' })).toContainText('پنل داخلی');
    expect(await seriousA11yViolations(page)).toEqual([]);

    await page.goto(`${STACK.webUrl}/panel/login`);
    await expect(page.getByRole('heading', { level: 1, name: 'ورود به پنل مرکز' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'درخواست همکاری' })).toBeVisible();
    expect(await seriousA11yViolations(page)).toEqual([]);
    await page.context().close();
  }
});

test('a center joins: the request, two people, the link, the first sign-in', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const f = fixture();
  const mobile = newMobile();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${STACK.webUrl}/panel/login`);
  await page.getByRole('link', { name: 'درخواست همکاری' }).click();
  await expect(page).toHaveURL(/\/join$/);
  const form = page.getByRole('form', { name: 'درخواست همکاری' });
  expect(await seriousA11yViolations(page)).toEqual([]);

  // Sent empty: each field says what it needs.
  await form.getByRole('button', { name: 'ارسال درخواست همکاری' }).click();
  await expect(form.getByText('نام مرکز یا مطب را بنویسید.')).toBeVisible();
  await expect(form.getByLabel('نام مرکز یا مطب')).toBeFocused();

  const name = `کلینیک همکار ${String(Date.now()).slice(-5)}`;
  await form.getByLabel('نام مرکز یا مطب').fill(name);
  await form.getByLabel('نوع مرکز').selectOption({ label: 'کلینیک' });
  await form.getByLabel('نوع شخص').selectOption({ label: 'حقیقی (مطب، پزشک)' });
  // The specialist of the seed covers Isfahan.
  await form.getByLabel('شهر').selectOption({ label: 'اصفهان' });
  await form.getByRole('group', { name: 'رشته‌های درمان' }).getByRole('checkbox').first().check();
  await form.getByLabel('نشانی').fill('اصفهان، خیابان آزمون، پلاک ۱۰');
  await form.getByLabel('نام و نام خانوادگی').fill('مریم احمدی');
  await form.getByLabel('موبایل مسئول').fill(`0${mobile}`);
  await form.getByRole('button', { name: 'ارسال کد تأیید' }).click();
  await form.getByLabel('کد تأیید پیامکی').fill(await otpFor(mobile));
  await form.getByLabel('نام پزشک ۱').fill('دکتر رضا کریمی');
  await form.getByLabel('نظام پزشکی پزشک ۱').fill('۱۲۳۴۵');
  const pdf = {
    name: 'license.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF\n'),
  };
  await page.locator('#file-license').setInputFiles(pdf);
  await page.locator('#file-owner_id').setInputFiles({ ...pdf, name: 'id.pdf' });
  await form.getByLabel(/درستی اطلاعات و مدارک را تأیید می‌کنم/).check();
  await form.getByRole('button', { name: 'ارسال درخواست همکاری' }).click();
  const receipt = page.getByRole('status');
  await expect(receipt).toContainText('درخواست شما ثبت شد', { timeout: 60_000 });
  const number = /کد پیگیری: ([۰-۹]+)/.exec((await receipt.textContent()) ?? '')?.[1] ?? '';
  expect(number).not.toBe('');

  // The specialist reviews it and registers the center as a draft.
  const specialist = await staffPage(
    browser,
    f.specialist,
    STACK.adminUrl,
    '/login',
    '/partnership',
  );
  await specialist.getByRole('link', { name: number }).click();
  await expect(specialist.getByRole('heading', { level: 1 })).toContainText(name);
  expect(await seriousA11yViolations(specialist)).toEqual([]);
  const review = specialist.getByRole('form', { name: 'تأیید اولیه' });
  await review.getByLabel('کد ملی صاحب مرکز').fill(nationalId());
  await review.getByLabel('یادداشت بررسی').fill('مدارک کامل و خواناست');
  await review.getByRole('button', { name: /تأیید اولیه/ }).click();
  await expect(specialist.getByText('تأیید اولیه؛ منتظر تأیید نهایی').first()).toBeVisible();
  await expect(specialist.getByText('تأیید اولیه با شما بود')).toBeVisible();
  await expect(specialist.getByRole('form', { name: 'تأیید نهایی' })).toHaveCount(0);

  // The network manager, another person, approves: the account and its link.
  const manager = await staffPage(
    browser,
    f.networkManager,
    STACK.adminUrl,
    '/login',
    '/partnership?status=reviewed',
  );
  await manager.getByRole('link', { name: number }).click();
  const approve = manager.getByRole('form', { name: 'تأیید نهایی' });
  await approve.getByLabel('یادداشت تأیید').fill('همکاری تأیید شد');
  await approve.getByRole('button', { name: 'تأیید نهایی و ارسال پیوند' }).click();
  await expect(manager.getByText('تأییدشده').first()).toBeVisible();
  await expect(manager.getByText('پیوند ساخت رمز پیامک شد')).toBeVisible();

  // The link sets the password once; the first sign-in sets up the authenticator app.
  const token = await setupTokenFor(mobile);
  const setup = await (await browser.newContext()).newPage();
  await setup.goto(`${STACK.webUrl}/setup#${token}`);
  const setupForm = setup.getByRole('form', { name: 'ساخت رمز' });
  await setupForm.getByLabel('رمز تازه').fill('Kh0sh-Amadid!Sepehr');
  await setupForm.getByLabel('تکرار رمز').fill('Kh0sh-Amadid!Sepehr');
  await setupForm.getByRole('button', { name: 'ساخت رمز' }).click();
  await expect(setup.getByText('رمز شما ساخته شد')).toBeVisible();
  // The same address with the same fragment is no new load: away first, then back.
  await setup.goto('about:blank');
  await setup.goto(`${STACK.webUrl}/setup#${token}`);
  await expect(setup.getByText('این پیوند به‌کار رفته یا منقضی شده است')).toBeVisible();
  await setup.goto(`${STACK.webUrl}/panel/login`);
  await setup
    .getByLabel('نام کاربری')
    .fill(`c${number.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))}`);
  await setup.getByLabel('رمز عبور').fill('Kh0sh-Amadid!Sepehr');
  await setup.getByRole('button', { name: 'ادامه' }).click();
  await expect(setup.getByText('فعال‌سازی ورود دومرحله‌ای')).toBeVisible();
});
