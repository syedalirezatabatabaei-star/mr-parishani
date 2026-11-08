import { expect, test, type Browser, type Page } from '@playwright/test';
import { STACK, type SeededStaff } from '../src/stack-config.ts';
import {
  fixture,
  menuNav,
  newMobile,
  patientLogin,
  seriousA11yViolations,
  staffLogin,
} from './support.ts';

/**
 * The service desk (owner 1405/08/10): right after sign-in every role lands on its desk, sees
 * only the services its permissions open, and finds them all again in the ☰ menu; a phone
 * gets the bar of shortcuts, a wide screen does not.
 */
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/** The desk's services as listed, the counters left out of the names. */
async function tiles(page: Page): Promise<string[]> {
  const services = page.getByRole('region', { name: 'خدمات' });
  await expect(services).toBeVisible();
  const names = await services
    .getByRole('link')
    .evaluateAll((links) =>
      links.map((a) =>
        (a.getAttribute('aria-label') ?? '')
          .replace(/، جدید$/, '')
          .replace(/، [۰-۹]+ مورد در انتظار$/, ''),
      ),
    );
  return names;
}

async function signIn(
  browser: Browser,
  viewport: { width: number; height: number },
  baseURL: string,
  login: '/login' | '/panel/login',
  staff: SeededStaff,
) {
  const page = await (await browser.newContext({ baseURL, viewport })).newPage();
  // No `next`: where a sign-in goes by itself.
  await page.goto(login);
  await staffLogin(page, staff);
  return page;
}

test('a new patient lands on the desk; the menu and the bar on a phone', async ({ browser }) => {
  const page = await (
    await browser.newContext({ baseURL: STACK.webUrl, viewport: PHONE })
  ).newPage();
  await page.goto('/login');
  await patientLogin(page, newMobile());
  await expect(page).toHaveURL(`${STACK.webUrl}/me`);
  await expect(page.getByRole('heading', { level: 1, name: 'پیشخوان' })).toBeVisible();
  expect(await tiles(page)).toEqual([
    'پیدا کردن پزشک',
    'نوبت‌های من',
    'پیش‌فاکتورها',
    'اعتبار من',
    'اقساط من',
    'قراردادها',
    'ضمانت‌های من',
    'پشتیبانی',
    'شماره موبایل',
  ]);
  await expect(
    page.getByRole('region', { name: 'خدمات' }).getByRole('button', { name: 'همه خدمات' }),
  ).toBeVisible();
  const bar = page.getByRole('navigation', { name: 'میانبرها' });
  await expect(bar).toBeVisible();
  // Owner 1405/08/11: the bar shows short labels; the links keep their full names.
  await expect(bar.getByRole('link')).toHaveText(['خانه', 'نوبت‌ها', 'پزشک', 'اقساط', 'پشتیبانی']);
  await expect(bar.getByRole('link', { name: 'نوبت‌های من' })).toBeVisible();
  expect(await seriousA11yViolations(page)).toEqual([]);

  // «همه خدمات» opens the menu, its groups in order; a link closes it on the way.
  await page.getByRole('button', { name: 'همه خدمات' }).click();
  const nav = page.getByRole('dialog').getByRole('navigation', { name: 'بخش‌های حساب من' });
  await expect(nav.getByRole('heading', { level: 2 })).toHaveText([
    'نوبت و پزشک',
    'اعتبار و پرداخت',
    'حساب و پشتیبانی',
  ]);
  await expect(page.getByRole('dialog').getByText('باشگاه مشتریان سپهر')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('switch', { name: 'حالت تیره' })).toBeVisible();
  expect(await seriousA11yViolations(page)).toEqual([]);
  await nav.getByRole('link', { name: 'اقساط من' }).click();
  await expect(page).toHaveURL(/\/me\/repayment$/);
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(bar.getByRole('link', { name: 'اقساط من' })).toHaveAttribute('aria-current', 'page');

  // The theme chosen is kept for the next page.
  await menuNav(page, 'بخش‌های حساب من');
  await page.getByRole('switch', { name: 'حالت تیره' }).click();
  await page.goto('/me');
  await expect(page.locator('[data-shell]')).toHaveAttribute('data-theme', 'dark');
});

test('the internal panel: each role its own services, on a wide screen without the bar', async ({
  browser,
}) => {
  const f = fixture();
  const strategy = await signIn(browser, DESKTOP, STACK.adminUrl, '/login', f.strategyA);
  await expect(strategy).toHaveURL(`${STACK.adminUrl}/`);
  expect(await tiles(strategy)).toEqual([
    'داشبورد واحدها',
    'گزارش‌ها',
    'سرنخ‌ها و پرونده‌ها',
    'تخصیص سرنخ و پرونده',
    'پرونده‌های اعتباری',
    'طرح‌ها و قواعد امتیاز',
    'تیکت‌ها',
    'پیامک',
    'نرخ‌های تسویه پزشک',
    'تعطیلات',
    'تنظیمات راه‌اندازی',
    'تنظیمات اقساط، چک و تسویه',
    'تنظیمات هویت، سرنخ، نوبت و پیامک',
  ]);
  await expect(strategy.getByRole('navigation', { name: 'میانبرها' })).toBeHidden();
  await expect(strategy.getByRole('region', { name: 'در انتظار شما' })).toBeVisible();
  // The top bar's search finds a service by name.
  await strategy.getByRole('searchbox', { name: 'جستجوی خدمات' }).first().fill('تعطیل');
  await strategy
    .getByRole('list', { name: 'نتیجه جستجو' })
    .getByRole('link', { name: 'تعطیلات' })
    .click();
  await expect(strategy).toHaveURL(/\/holidays$/);
  const nav = await menuNav(strategy, 'بخش‌های پنل داخلی');
  await expect(nav.getByRole('link', { name: 'تعطیلات' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'نقش‌ها و دسترسی‌ها' })).toHaveCount(0);
  expect(await seriousA11yViolations(strategy)).toEqual([]);

  const admin = await signIn(browser, DESKTOP, STACK.adminUrl, '/login', f.admin);
  // The seed's system admin holds other roles too: its own sections, and no credit queue.
  const adminTiles = await tiles(admin);
  expect(adminTiles).toEqual(
    expect.arrayContaining(['نقش‌ها و دسترسی‌ها', 'شماره امضاکنندگان', 'تنظیمات راه‌اندازی']),
  );
  expect(adminTiles).not.toContain('پرونده‌های اعتباری');
  expect(adminTiles).not.toContain('معوقات و وصول');

  // The CEO's desk carries the dashboard in brief, the whole of it one click away.
  const ceo = await signIn(browser, DESKTOP, STACK.adminUrl, '/login', f.ceo);
  const brief = ceo.getByRole('region', { name: 'خلاصه داشبورد مدیرعامل' });
  await expect(brief).toContainText('پرونده‌های فعال');
  await brief.getByRole('link', { name: 'داشبورد کامل' }).click();
  await expect(ceo).toHaveURL(/\/dashboard$/);
});

test('the center panel: the manager’s desk on a phone, its summary and its services', async ({
  browser,
}) => {
  const { manager } = fixture();
  const page = await signIn(browser, PHONE, STACK.webUrl, '/panel/login', manager);
  await expect(page).toHaveURL(`${STACK.webUrl}/panel`);
  expect(await tiles(page)).toEqual([
    'داشبورد',
    'نوبت‌ها',
    'تقویم کاری',
    'پیش‌فاکتورها',
    'تاریخچه خدمات',
    'تسویه',
    'تیکت‌ها',
    'پزشکان و منشی‌ها',
    'خدمات و تعرفه',
    'مرکز و شعبه‌ها',
  ]);
  await expect(page.getByRole('region', { name: 'خلاصه امروز' })).toContainText('نوبت‌های امروز');
  await expect(page.getByRole('navigation', { name: 'میانبرها' })).toBeVisible();
  const nav = await menuNav(page, 'بخش‌های پنل');
  await expect(nav.getByRole('link', { name: 'حساب من' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'بیماران اعتباری' })).toHaveCount(0);
});
