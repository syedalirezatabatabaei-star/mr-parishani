import { gzipSync } from 'node:zlib';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixture, newMobile, patientLogin } from './support.ts';

/**
 * The patient pages' performance budget on a simulated phone (task 2-11, part 5; decision 2
 * of task-2-11-decisions.md, doc 09 gives no numbers): the production build, a cold cache,
 * CPU slowed four times and a fast 4G network (9 Mbit/s, 170 ms). Each patient route stays
 * within LCP ≤ 2.5 s, CLS ≤ 0.1 and 200 KB of gzip JavaScript on first load.
 */
const BUDGET = { lcpMs: 2500, cls: 0.1, jsGzipBytes: 200 * 1024 } as const;

const PHONE = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
} as const;

/** What the page measured itself: the last LCP candidate and the layout shifts (no input). */
const OBSERVE = () => {
  const w = window as unknown as { __perf: { lcp: number; cls: number } };
  w.__perf = { lcp: 0, cls: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__perf.lcp = e.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & {
      value: number;
      hadRecentInput: boolean;
    })[]) {
      if (!e.hadRecentInput) w.__perf.cls += e.value;
    }
  }).observe({ type: 'layout-shift', buffered: true });
};

interface Measured {
  readonly lcpMs: number;
  readonly cls: number;
  readonly jsGzipBytes: number;
}

async function measure(page: Page, path: string): Promise<Measured> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 170,
    downloadThroughput: (9_000_000 / 8) | 0,
    uploadThroughput: (1_500_000 / 8) | 0,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(OBSERVE);

  // Every script of the first load, gzipped here: the same size whatever the server sends.
  const scripts: Promise<number>[] = [];
  page.on('response', (r) => {
    if (r.request().resourceType() === 'script') {
      scripts.push(
        r.body().then(
          (b) => gzipSync(b).length,
          () => 0,
        ),
      );
    }
  });
  const response = await page.goto(path, { waitUntil: 'load' });
  expect(response?.status(), path).toBe(200);
  await page.waitForLoadState('networkidle');
  // LCP is settled once the page is idle; a short pause lets the observers report.
  await page.waitForTimeout(500);
  const { lcp, cls } = await page.evaluate(
    () => (window as unknown as { __perf: { lcp: number; cls: number } }).__perf,
  );
  const sizes = await Promise.all(scripts);
  await cdp.detach();
  return { lcpMs: Math.round(lcp), cls, jsGzipBytes: sizes.reduce((a, b) => a + b, 0) };
}

/** A phone of its own; signed in as a new patient when the route needs it. */
async function phone(browser: Browser, signedIn: boolean): Promise<Page> {
  const context = await browser.newContext(PHONE);
  if (signedIn) {
    const login = await context.newPage();
    await login.goto('/login?next=%2Fme%2Fappointments');
    await patientLogin(login, newMobile());
    await expect(login).toHaveURL(/\/me\/appointments/);
    await login.close();
  }
  return context.newPage();
}

const ROUTES: readonly {
  readonly name: string;
  readonly path: () => string;
  readonly signedIn: boolean;
}[] = [
  { name: 'home', path: () => '/', signedIn: false },
  { name: 'search', path: () => `/search?q=${encodeURIComponent('آفتاب')}`, signedIn: false },
  { name: 'doctor', path: () => `/doctors/${fixture().profileSlug}`, signedIn: false },
  { name: 'login', path: () => '/login', signedIn: false },
  { name: 'book', path: () => `/book/${fixture().workplaceId}`, signedIn: true },
  { name: 'my appointments', path: () => '/me/appointments', signedIn: true },
  // Phase 3 (task 3-8): the patient's proformas, credit and guarantees.
  { name: 'my proformas', path: () => '/me/proformas', signedIn: true },
  { name: 'my credit', path: () => '/me/credit', signedIn: true },
  { name: 'my guarantees', path: () => '/me/guarantees', signedIn: true },
  // Task 4-4: the party's contracts.
  { name: 'my contracts', path: () => '/me/contracts', signedIn: true },
  // Task 6-9: the borrower's installments and slips.
  { name: 'my installments', path: () => '/me/repayment', signedIn: true },
];

for (const route of ROUTES) {
  test(`budget on a phone: ${route.name}`, async ({ browser }) => {
    const page = await phone(browser, route.signedIn);
    const m = await measure(page, route.path());
    test.info().annotations.push({
      type: 'measured',
      description: `LCP ${String(m.lcpMs)} ms, CLS ${m.cls.toFixed(3)}, JS ${String(
        Math.round(m.jsGzipBytes / 1024),
      )} KB gzip`,
    });
    console.log(`${route.name}: ${JSON.stringify(m)}`);
    expect(m.lcpMs, 'LCP measured').toBeGreaterThan(0);
    expect(m.lcpMs, 'LCP').toBeLessThanOrEqual(BUDGET.lcpMs);
    expect(m.cls, 'CLS').toBeLessThanOrEqual(BUDGET.cls);
    expect(m.jsGzipBytes, 'JS gzip').toBeLessThanOrEqual(BUDGET.jsGzipBytes);
    // Task 6-9: the page never scrolls sideways on a phone (a fifth header link once did).
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(scroll, 'no horizontal page scroll').toBeLessThanOrEqual(client);
  });
}
