import { expect, test, type Browser, type Page } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { fixture, newMobile, otpFor, seriousA11yViolations, staffPage } from './support.ts';

/**
 * Owner 1405/08/10–11: the portal's content by two people (a banner, a text page, an
 * announcement), what the desk, the public page and the bell then show, and the patient's
 * sign-in in three steps (mobile, code, ready).
 */

/** A step fades in (320 ms): checked once it is still, not half transparent. */
async function settled(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState === 'finished'),
  );
}

async function patientDesk(browser: Browser) {
  const page = await (
    await browser.newContext({ baseURL: STACK.webUrl, viewport: { width: 390, height: 844 } })
  ).newPage();
  const mobile = newMobile();
  await page.goto('/login');
  await expect(
    page.getByRole('list', { name: 'مراحل ورود' }).getByRole('listitem').first(),
  ).toHaveAttribute('aria-current', 'step');
  await settled(page);
  expect(await seriousA11yViolations(page)).toEqual([]);
  await page.getByLabel('شماره موبایل').fill(`0${mobile}`);
  await page.getByRole('button', { name: 'دریافت کد ورود' }).click();
  await expect(page.getByText('کد ورود به شماره')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'مراحل ورود' }).getByRole('listitem').nth(1),
  ).toHaveAttribute('aria-current', 'step');
  await settled(page);
  expect(await seriousA11yViolations(page)).toEqual([]);
  await page.getByLabel('کد ورود').fill(await otpFor(mobile));
  await page.getByRole('button', { name: 'ورود', exact: true }).click();
  await expect(page.getByText('آماده است')).toBeVisible();
  await expect(page).toHaveURL(`${STACK.webUrl}/me`);
  return page;
}

test('content by two people: a banner on the desk, a page in public, an announcement in the bell', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const f = fixture();
  const admin = await staffPage(browser, f.admin, STACK.adminUrl, '/login', '/content/banners');
  expect(await seriousA11yViolations(admin)).toEqual([]);
  const fresh = admin.getByRole('form', { name: 'بنر تازه' });
  await fresh.getByLabel('عنوان').fill('بنر آزمون پیشخوان');
  await fresh.getByLabel(/متن کوتاه/).fill('متن کوتاه بنر آزمون');
  await fresh.getByLabel('دلیل تغییر').fill('آزمون e2e');
  await fresh.getByRole('button', { name: 'پیشنهاد بنر' }).click();
  await expect(fresh.getByText('پیشنهاد ثبت شد')).toBeVisible();
  // The proposer cannot decide their own.
  await admin.reload();
  await expect(admin.getByText('پیشنهاد شما؛ نفر دوم تصمیم می‌گیرد.').first()).toBeVisible();

  const support = await staffPage(browser, f.support, STACK.adminUrl, '/login', '/content/banners');
  const banner = support.getByRole('listitem').filter({ hasText: 'بنر آزمون پیشخوان' });
  await banner.getByRole('button', { name: 'تأیید' }).click();
  await expect(banner.getByText('تأییدشده')).toBeVisible();

  // A text page from the editor, previewed, approved, public.
  await admin.goto(`${STACK.adminUrl}/content/pages/about`);
  await expect(admin.getByText('متن حقوقی نهایی')).toBeVisible();
  await admin.getByLabel('عنوان صفحه').fill('درباره سپهر سلامتی');
  await admin.getByLabel('متن پاراگراف').first().fill('متن نمونه درباره سپهر');
  await admin.getByRole('button', { name: 'افزودن فهرست' }).click();
  await admin.getByLabel(/بندهای فهرست/).fill('نوبت آنلاین\nاعتبار درمان');
  const preview = admin.getByRole('region', { name: 'پیش‌نمایش' });
  await expect(preview.getByRole('listitem')).toHaveText(['نوبت آنلاین', 'اعتبار درمان']);
  await admin.getByLabel('دلیل تغییر').fill('آزمون e2e');
  await admin.getByRole('button', { name: 'پیشنهاد نسخه تازه' }).click();
  await expect(admin.getByText('پیشنهاد ثبت شد')).toBeVisible();
  await support.goto(`${STACK.adminUrl}/content/pages/about`);
  await support.getByRole('button', { name: 'تأیید' }).click();
  await expect(support.getByText('تأییدشده').first()).toBeVisible();
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`${STACK.webUrl}/pages/about`);
  await expect(
    visitor.getByRole('heading', { level: 1, name: 'درباره سپهر سلامتی' }),
  ).toBeVisible();
  await expect(visitor.getByText('متن نمونه درباره سپهر')).toBeVisible();

  // An urgent announcement for patients.
  await admin.goto(`${STACK.adminUrl}/content/announcements`);
  const announce = admin.getByRole('form', { name: 'اطلاعیه تازه' });
  await announce.getByLabel('عنوان').fill('اطلاعیه فوری آزمون');
  await announce.getByLabel('مخاطب').selectOption({ label: 'بیماران' });
  await announce.getByLabel('متن').fill('متن اطلاعیه آزمون');
  await announce.getByLabel(/فوری/).check();
  await announce.getByLabel('دلیل').fill('آزمون e2e');
  await announce.getByRole('button', { name: 'پیشنهاد اطلاعیه' }).click();
  await expect(announce.getByText('پیشنهاد ثبت شد')).toBeVisible();
  await support.goto(`${STACK.adminUrl}/content/announcements`);
  await support
    .getByRole('listitem')
    .filter({ hasText: 'اطلاعیه فوری آزمون' })
    .getByRole('button', { name: 'تأیید' })
    .click();
  await expect(support.getByText('تأییدشده').first()).toBeVisible();

  // The patient: the banner on the desk, the announcement in the bell, read once opened.
  const desk = await patientDesk(browser);
  await expect(desk.getByRole('region', { name: 'اطلاعیه‌ها' }).first()).toContainText(
    'بنر آزمون پیشخوان',
  );
  const bell = desk.getByRole('button', { name: /^اعلان‌ها، ۱ خوانده‌نشده/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const drawer = desk.getByRole('dialog', { name: 'اعلان‌ها' });
  await expect(drawer.getByText('اطلاعیه فوری آزمون')).toBeVisible();
  await expect(drawer.getByText('فوری', { exact: true })).toBeVisible();
  expect(await seriousA11yViolations(desk)).toEqual([]);
  await drawer.getByRole('button', { name: 'همه خوانده شد' }).click();
  await expect(drawer.getByRole('button', { name: 'همه خوانده شد' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'بستن اعلان‌ها' }).click();
  await expect(desk.getByRole('button', { name: 'اعلان‌ها', exact: true })).toBeVisible();
});
