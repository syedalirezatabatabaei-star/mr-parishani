import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { structuredDataProblems } from '../../web/lib/structured-data.ts';
import { fixture, staffPage } from './support.ts';

/** Doc 08 §15 test 10, second half (doc 09 acceptance): noindex and structured data. */
test('a published profile is indexable, canonical, with Physician and MedicalClinic data', async ({
  page,
}) => {
  const { profileSlug, doctorName, centerName } = fixture();
  const response = await page.goto(`/doctors/${profileSlug}`);
  expect(response?.status()).toBe(200);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /index, follow/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    `http://localhost:3101/doctors/${profileSlug}`,
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', doctorName);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /اصفهان/);
  const data = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ?? '{}',
  ) as { '@graph': { '@type': string; name: string }[] };
  const types = data['@graph'].map((n) => n['@type']);
  expect(types).toContain('Physician');
  expect(types).toContain('MedicalClinic');
  expect(data['@graph'].find((n) => n['@type'] === 'Physician')?.name).toBe(doctorName);
  expect(data['@graph'].find((n) => n['@type'] === 'MedicalClinic')?.name).toBe(centerName);
});

test('an unknown or unpublished profile is not found and never indexed', async ({ page }) => {
  const response = await page.goto('/doctors/no-such-doctor-e2e');
  expect(response?.status()).toBe(404);
  // Next adds its own robots tag to a 404; every one of them must say noindex.
  const robots = page.locator('meta[name="robots"]');
  await expect(robots.first()).toBeAttached();
  for (const content of await robots.evaluateAll((tags) =>
    tags.map((t) => t.getAttribute('content')),
  )) {
    expect(content).toMatch(/noindex/);
  }
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
});

test('task 8-3: the structured data passes the local validator', async ({ page }) => {
  const { profileSlug } = fixture();
  await page.goto(`/doctors/${profileSlug}`);
  const data = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ?? '{}',
  ) as unknown;
  expect(structuredDataProblems(data)).toEqual([]);
});

test('task 8-3: robots.txt closes what is behind a sign-in and names the sitemap', async ({
  request,
}) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  const text = await res.text();
  for (const path of ['/me/', '/panel/', '/login', '/book/', '/api/']) {
    expect(text).toContain(`Disallow: ${path}`);
  }
  expect(text).toContain(`Sitemap: ${STACK.webUrl}/sitemap.xml`);
});

test('task 8-3: the sitemap lists the indexable profiles only', async ({ request }) => {
  const { profileSlug } = fixture();
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  const xml = await res.text();
  // nosemgrep: html-in-template-string -- test fixture markup, never rendered in a browser
  expect(xml).toContain(`<loc>${STACK.webUrl}/doctors/${profileSlug}</loc>`);
  expect(xml).not.toMatch(/\/(me|panel|login|book)[/<]/);
  // Every doctor in it is published and offered to search engines (whatever other tests
  // published before this one runs).
  const doctors = [...xml.matchAll(/<loc>([^<]*\/doctors\/[^<]*)<\/loc>/g)].map((m) => m[1] ?? '');
  expect(doctors.length).toBeGreaterThan(0);
  for (const url of doctors) {
    const page = await request.get(url);
    expect(page.status(), url).toBe(200);
    expect(await page.text(), url).toMatch(/<meta name="robots" content="index, follow"/);
  }
});

test('task 8-3: the link list for WordPress, as a CSV Persian Excel opens', async ({ browser }) => {
  const f = fixture();
  const page = await staffPage(browser, f.specialist, STACK.adminUrl, '/login', '/profiles/links');
  const table = page.getByRole('table', { name: 'پروفایل‌های منتشرشده' });
  const url = `${STACK.webUrl}/doctors/${f.profileSlug}`;
  await expect(table.getByRole('link', { name: url })).toBeVisible();
  await expect(table.getByText('قابل نمایه').first()).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'دریافت CSV' }).click();
  const file = await downloading;
  const path = await file.path();
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(path);
  // UTF-8 with a byte order mark (doc 17 §5), the header in Persian, the address in it.
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString('utf8');
  expect(text).toContain('"نام پزشک","نشانی"');
  expect(text).toContain(`"${url}"`);
});
