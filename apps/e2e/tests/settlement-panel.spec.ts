import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { STACK } from '../src/stack-config.ts';
import { checkPage } from './credit-steps.ts';
import { fixture, serviceCodeFor, signedPost, staffPage } from './support.ts';

/**
 * Task 5-6 (doc 06 §6; doc 14 5-6 acceptance): the doctor's settlement panel. A final service
 * becomes an upcoming item (the worker makes its payable); the doctor objects to it and it is
 * held, with its dispute's state (a financial complaint from task 7-7); accounting rejects the dispute and the item is upcoming
 * again, for the statement it falls due in. (The next month's statement itself is the
 * integration test of 5-4: its due day is a month away.)
 */
test('dispute → on_hold → resolved → back for the next statement', async ({ browser }) => {
  test.setTimeout(240_000);
  const f = fixture();
  const reason = `مبلغ این خدمت درست نیست ${randomUUID().slice(0, 8)}`;

  // The service, on the seeded purse: authorized, its code entered, final at once.
  const doctor = await staffPage(
    browser,
    f.doctor,
    STACK.webUrl,
    '/panel/login',
    `/panel/patients/${f.settlementPurseId}`,
  );
  await doctor.getByRole('checkbox').first().check();
  await doctor.getByRole('button', { name: 'صدور و ارسال کد به بیمار' }).click();
  await expect(doctor).toHaveURL(/\/panel\/authorizations\//);
  await doctor
    .getByLabel('کد پیامک‌شده به بیمار')
    .fill(await serviceCodeFor(f.settlementPatientMobile));
  await doctor.getByRole('button', { name: 'ثبت خدمت' }).click();
  await expect(doctor.getByText('خدمت ثبت و قطعی شد.')).toBeVisible();

  // The panel: the worker makes the payable from the event, so read again until it is there.
  await doctor.goto('/panel/settlement');
  const upcoming = doctor.getByRole('table', { name: 'دریافتی‌های آینده' });
  await expect(async () => {
    await doctor.reload();
    await expect(upcoming.getByRole('button', { name: 'اعتراض' }).first()).toBeVisible({
      timeout: 2_000,
    });
  }).toPass({ timeout: 90_000 });
  await expect(upcoming).toContainText('صورت‌وضعیت');
  // Jalali only, tomans only (rules 2, 21).
  expect(await doctor.locator('main').innerText()).not.toMatch(/\b20\d\d\b/);
  await checkPage(doctor);
  // Other tests' services of this doctor may still be arriving: count only what is held,
  // which only this test changes.
  await expect(doctor.getByText('باز، در دست بررسی')).toHaveCount(0);

  // The objection: held, with its dispute open.
  await upcoming.getByRole('button', { name: 'اعتراض' }).last().click();
  const form = doctor.getByRole('form', { name: 'ثبت اعتراض' });
  await form.getByLabel('دلیل اعتراض').fill(reason);
  await form.getByRole('button', { name: 'ثبت اعتراض' }).click();
  const held = doctor.getByRole('table', { name: 'اقلام معلق به‌دلیل اعتراض' });
  await expect(held).toContainText('باز، در دست بررسی');
  await expect(held.getByText('باز، در دست بررسی')).toHaveCount(1);
  await checkPage(doctor);
  // Task 7-7 (the owner's ruling): the objection is a financial complaint, with its conversation.
  await doctor.goto('/panel/tickets');
  await expect(
    doctor.getByRole('table', { name: 'تیکت‌های مرکز' }).getByText('اعتراض به قلم تسویه').first(),
  ).toBeVisible();
  await doctor.goto('/panel/settlement');

  // Accounting rejects it (its panel is task 5-7): through the API, as another person.
  const finance = await staffPage(browser, f.finance, STACK.adminUrl, '/login', '/');
  const me = (await (await finance.request.get('/api/v1/auth/me')).json()) as {
    csrfToken: string;
  };
  const open = (await (
    await finance.request.get('/api/v1/settlement/disputes?status=open')
  ).json()) as { id: string; reason: string }[];
  const dispute = open.find((d) => d.reason === reason);
  expect(dispute).toBeDefined();
  const resolved = await signedPost(
    finance,
    `/api/v1/settlement/disputes/${dispute?.id ?? ''}/resolve`,
    {
      headers: { 'x-csrf-token': me.csrfToken, origin: STACK.adminUrl },
      data: { outcome: 'rejected', note: 'بررسی شد؛ مبلغ درست است' },
    },
  );
  expect(resolved.status(), await resolved.text()).toBe(201);

  // Back among the upcoming, for the statement it falls due in; nothing held.
  await doctor.reload();
  await expect(doctor.getByText('باز، در دست بررسی')).toHaveCount(0);
  await expect(upcoming.getByRole('button', { name: 'اعتراض' }).first()).toBeVisible();
  await checkPage(doctor);
});
