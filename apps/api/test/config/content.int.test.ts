import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  grantRole,
  loggedInAccount,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { CREDIT_HARNESS, type Body, type Row } from '../credit/world';
import { call } from '../identity/harness';

/**
 * The portal's content and the bell (owner 1405/08/10; migration 0110): banners, text pages
 * and announcements proposed by the system admin and decided by support or another system
 * admin, never the proposer; at most five banners per audience; the desk and the public pages
 * read only what is approved; each account's bell lists its own notifications and the
 * announcements meant for it, read marks its own.
 */

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

let h: Harness;
let admin: LoggedInAccount;
let admin2: LoggedInAccount;
let support: LoggedInAccount;
let patientToken: string;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  admin = await loggedInAccount(h, 'staff');
  await grantRole(h, admin.id, 'system_admin');
  admin2 = await loggedInAccount(h, 'staff');
  await grantRole(h, admin2.id, 'system_admin');
  support = await loggedInAccount(h, 'staff');
  await grantRole(h, support.id, 'support');
  const login = await otpLogin(h, newMobile(), 'mobile');
  patientToken = login.body['accessToken'] as string;
}, 180_000);

afterAll(async () => {
  await h.close();
});

const staff = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });
const patient = (method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: patientToken, ...(body === undefined ? {} : { body }) });
const anon = async (path: string) => {
  const res = await fetch(`${h.baseUrl}${path}`);
  return { status: res.status, body: (await res.json()) as Body };
};

const banner = (over: Record<string, unknown> = {}) => ({
  proposal: JSON.stringify({
    title: 'بنر آزمون',
    body: 'متن کوتاه بنر',
    tone: 'teal',
    linkHref: '/search',
    linkLabel: 'جست‌وجو',
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    audiences: ['patient'],
    active: true,
    reason: 'آزمون',
    ...over,
  }),
});

describe('the desk banners, by two people', () => {
  it('runs once approved by another, for its audience only, with its picture', async () => {
    const made = await staff(admin, 'POST', '/config/content/banners', banner());
    expect(made.status).toBe(201);
    const id = made.body['id'] as string;
    // Pending: no desk shows it.
    expect((await anon('/config/banners?audience=patient')).body).toEqual([]);
    // Never the proposer; never a support member proposing.
    expect(
      (await staff(admin, 'POST', `/config/content/banners/${id}/decision`, { approve: true }))
        .body['error'],
    ).toBe('second_person_required');
    expect((await staff(support, 'POST', '/config/content/banners', banner())).status).toBe(403);
    // The approver was told in the bell.
    const told = await call(h, 'GET', '/me/inbox', { bearer: support.access });
    expect((told.body['items'] as Body[]).some((i) => i['kind'] === 'content.proposed')).toBe(true);
    expect(
      (await staff(support, 'POST', `/config/content/banners/${id}/decision`, { approve: true }))
        .status,
    ).toBe(200);
    const desk = await anon('/config/banners?audience=patient');
    expect(desk.body).toMatchObject([{ title: 'بنر آزمون', tone: 'teal', linkHref: '/search' }]);
    expect((await anon('/config/banners?audience=staff')).body).toEqual([]);
    // A decided version never changes (the database refuses it).
    await expect(
      h.owner.query(`UPDATE dashboard_banners SET title = 'دیگر' WHERE id = $1`, [id]),
    ).rejects.toThrow(/does not change/);

    // A new version with a picture, served by the API once approved.
    const form = new FormData();
    form.append(
      'proposal',
      banner({ bannerKey: made.body['bannerKey'], title: 'بنر آزمون ۲' }).proposal,
    );
    form.append('image', new Blob([new Uint8Array(PNG)]), 'b.png');
    const res = await fetch(`${h.baseUrl}/config/content/banners`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.access}` },
      body: form,
    });
    const v2 = (await res.json()) as Body;
    expect(v2).toMatchObject({ version: 2, hasImage: true });
    await staff(admin2, 'POST', `/config/content/banners/${v2['id'] as string}/decision`, {
      approve: true,
    });
    const shown = (await anon('/config/banners?audience=patient')).body as unknown as Body[];
    expect(shown).toHaveLength(1);
    // Persian digits are stored as ASCII (rule 23).
    expect(shown[0]?.['title']).toBe('بنر آزمون 2');
    const image = await fetch(
      `${h.baseUrl}${(shown[0]?.['imageUrl'] as string).replace('/api/v1', '')}`,
    );
    expect(image.headers.get('content-type')).toBe('image/png');
  });

  it('keeps five at most for an audience, and a rejection needs a reason', async () => {
    for (let i = 0; i < 4; i += 1) {
      const v = await staff(
        admin,
        'POST',
        '/config/content/banners',
        banner({ title: `بنر ${String(i)}` }),
      );
      expect(
        (
          await staff(
            support,
            'POST',
            `/config/content/banners/${v.body['id'] as string}/decision`,
            {
              approve: true,
            },
          )
        ).status,
      ).toBe(200);
    }
    const sixth = await staff(admin, 'POST', '/config/content/banners', banner({ title: 'ششم' }));
    const refused = await staff(
      support,
      'POST',
      `/config/content/banners/${sixth.body['id'] as string}/decision`,
      {
        approve: true,
      },
    );
    expect(refused.body['error']).toBe('too_many_active_banners');
    expect(
      (
        await staff(
          support,
          'POST',
          `/config/content/banners/${sixth.body['id'] as string}/decision`,
          {
            approve: false,
          },
        )
      ).body['error'],
    ).toBe('reason_required');
  });
});

describe('the text pages', () => {
  it('are public once approved, the newest approved version', async () => {
    expect((await anon('/config/pages/about')).status).toBe(404);
    const v = await staff(admin, 'POST', '/config/content/pages/about', {
      title: 'درباره',
      blocks: [
        { kind: 'heading', text: 'ما' },
        { kind: 'paragraph', text: 'سپهر سلامتی' },
        { kind: 'list', items: ['یک', 'دو'] },
        { kind: 'link', text: 'همکاری', href: '/join' },
      ],
      reason: 'نخستین متن',
    });
    expect(v.status).toBe(201);
    // A link to another site is refused (no outside dependency).
    expect(
      (
        await staff(admin, 'POST', '/config/content/pages/about', {
          title: 'درباره',
          blocks: [{ kind: 'link', text: 'بیرون', href: 'https://example.com' }],
          reason: 'آزمون',
        })
      ).status,
    ).toBe(400);
    await staff(
      support,
      'POST',
      `/config/content/pages/versions/${v.body['id'] as string}/decision`,
      {
        approve: true,
      },
    );
    const page = await anon('/config/pages/about');
    expect(page.body).toMatchObject({ slug: 'about', title: 'درباره', version: 1 });
    expect((page.body['blocks'] as Body[]).length).toBe(4);
    expect((await anon('/config/pages/nothing')).status).toBe(400);
  });
});

describe('the bell', () => {
  it('lists the announcements for the account, urgent first, and marks them read', async () => {
    const propose = (body: Record<string, unknown>) =>
      staff(admin, 'POST', '/config/content/announcements', {
        body: 'متن اطلاعیه',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        active: true,
        reason: 'آزمون',
        roleCode: null,
        ...body,
      });
    const forPatients = await propose({
      title: 'برای بیماران',
      audience: 'patients',
      urgent: true,
    });
    const forStaff = await propose({ title: 'برای کارکنان', audience: 'staff', urgent: false });
    const forSupport = await propose({
      title: 'برای پشتیبانی',
      audience: 'role',
      roleCode: 'support',
      urgent: false,
    });
    for (const a of [forPatients, forStaff, forSupport]) {
      await staff(
        admin2,
        'POST',
        `/config/content/announcements/${a.body['id'] as string}/decision`,
        {
          approve: true,
        },
      );
    }
    const mine = await patient('GET', '/me/inbox');
    const titles = (mine.body['items'] as Body[]).map((i) => i['title']);
    expect(titles).toContain('برای بیماران');
    expect(titles).not.toContain('برای کارکنان');
    expect(mine.body['unread']).toBe(1);
    const theirs = await staff(support, 'GET', '/me/inbox');
    const supportTitles = (theirs.body['items'] as Body[]).map((i) => i['title']);
    expect(supportTitles).toEqual(expect.arrayContaining(['برای کارکنان', 'برای پشتیبانی']));
    expect(supportTitles).not.toContain('برای بیماران');
    const adminTitles = ((await staff(admin, 'GET', '/me/inbox')).body['items'] as Body[]).map(
      (i) => i['title'],
    );
    expect(adminTitles).not.toContain('برای پشتیبانی');

    const id = (mine.body['items'] as Body[]).find((i) => i['title'] === 'برای بیماران')?.['id'];
    expect((await patient('POST', '/me/inbox/read', { ids: [id] })).status).toBe(200);
    expect((await patient('GET', '/me/inbox')).body['unread']).toBe(0);
    await staff(support, 'POST', '/me/inbox/read', { all: true });
    expect((await staff(support, 'GET', '/me/inbox')).body['unread']).toBe(0);
    // Read marks are each account's own.
    const rows = await h.owner.query<Row>('SELECT count(*)::int AS n FROM announcement_reads');
    expect(Number(rows.rows[0]?.['n'])).toBeGreaterThanOrEqual(3);
  });
});
