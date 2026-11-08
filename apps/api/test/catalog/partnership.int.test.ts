import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SETUP_LINK_SENDER } from '../../src/modules/identity/account-setup.service';
import {
  newIp,
  newMobile,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';
import { nationalId } from './fixtures';

/**
 * Partnership requests (owner 1405/08/10; migration 0110): the public form with its anti-bot
 * measures (proof of work, honeypot, the code, the limits), the documents scanned, the
 * specialist's review that registers the center as a draft, the manager's approval by another
 * person that makes the account and sends its one-time link, and the link itself. No ledger row,
 * no activation.
 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

class CapturingText {
  readonly sent: { mobile: string; text: string; jobId: string }[] = [];
  /** Makes the next send fail, as if the queue were down. */
  failNext = false;
  sendText(job: { mobile: string; text: string }, jobId: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('queue unavailable'));
    }
    // BullMQ refuses a custom id with a colon (found in the demo, 1405/08/11).
    if (jobId.includes(':')) return Promise.reject(new Error('Custom Id cannot contain :'));
    this.sent.push({ ...job, jobId });
    return Promise.resolve();
  }
}

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let manager: LoggedInAccount;
const links = new CapturingText();

beforeAll(async () => {
  h = await startHarness({ ...CREDIT_HARNESS, overrides: [[SETUP_LINK_SENDER, links]] });
  w = await creditWorld(h);
  // The world's specialist (Tehran) reviews; a network manager approves.
  manager = await w.role('network_manager');
}, 180_000);

afterAll(async () => {
  await h.close();
});

const zeroBits = (digest: Buffer) => {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
};

async function proof() {
  const res = await fetch(`${h.baseUrl}/catalog/partnership/challenge`);
  const c = (await res.json()) as { challenge: string; bits: number };
  for (let counter = 0; ; counter += 1) {
    const digest = createHash('sha256')
      .update(`${c.challenge}:${String(counter)}`)
      .digest();
    if (zeroBits(digest) >= c.bits) return { challenge: c.challenge, counter };
  }
}

const json = async (path: string, body: unknown, ip = newIp()) => {
  const res = await fetch(`${h.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Body };
};

async function code(mobile: string) {
  const sent = await json('/catalog/partnership/code', { mobile, proof: await proof() });
  expect(sent.status).toBe(202);
  return h.sms.lastCodeFor(mobile);
}

function request(mobile: string, otp: string, over: Record<string, unknown> = {}) {
  return {
    centerName: 'کلینیک همکار تازه',
    placeKind: 'clinic',
    personType: 'natural',
    cityCode: 'tehran',
    treatmentFieldCodes: ['dental'],
    address: 'تهران، خیابان آزمون، پلاک ۱۲',
    phone: '02188776655',
    managerName: 'مریم احمدی',
    managerRole: 'مدیر داخلی',
    mobile,
    code: otp,
    doctors: [{ name: 'دکتر رضا کریمی', councilNumber: '۱۲۳۴۵', specialty: 'دندان‌پزشکی' }],
    ...over,
  };
}

async function submit(body: Record<string, unknown>, files: string[] = ['license', 'owner_id']) {
  const form = new FormData();
  form.append('request', JSON.stringify({ ...body, proof: await proof() }));
  for (const kind of files) form.append(kind, new Blob([new Uint8Array(PDF)]), `${kind}.pdf`);
  const res = await fetch(`${h.baseUrl}/catalog/partnership/requests`, {
    method: 'POST',
    headers: { 'x-forwarded-for': newIp() },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const smsOf = async (mobile: string) =>
  (
    await h.owner.query<Row>(
      `SELECT t.code FROM sms_dispatches d JOIN sms_templates t ON t.id = d.template_id
       WHERE d.mobile = $1 ORDER BY d.created_at`,
      [mobile],
    )
  ).rows.map((r) => r['code']);

describe('a partnership request, from the public form to the center manager’s password', () => {
  it('is received, reviewed by one, approved by another, and its link works once', async () => {
    const mobile = newMobile();
    const ledger = (await h.owner.query<Row>('SELECT count(*)::int AS n FROM ledger_entries'))
      .rows[0]?.['n'];
    const sent = await submit(request(mobile, await code(mobile)));
    expect(sent.status).toBe(201);
    const number = sent.body['number'] as number;
    expect(number).toBeGreaterThanOrEqual(1001);
    expect(await smsOf(mobile)).toEqual(['partnership.received']);

    const queue = await w.staff(
      w.specialist,
      'GET',
      '/catalog/partnership-requests?status=pending',
    );
    const row = (queue.body as unknown as Body[]).find((r) => r['number'] === number);
    expect(row).toMatchObject({ centerName: 'کلینیک همکار تازه', status: 'pending' });
    const id = row?.['id'] as string;
    const view = await w.staff(w.specialist, 'GET', `/catalog/partnership-requests/${id}`);
    expect(view.body).toMatchObject({
      mobileLastFour: mobile.slice(-4),
      doctors: [{ name: 'دکتر رضا کریمی', councilNumber: '12345' }],
    });
    expect((view.body['documents'] as Body[]).map((d) => d['kind'])).toEqual([
      'license',
      'owner_id',
    ]);
    expect(JSON.stringify(view.body)).not.toContain(mobile);

    // The reviewers were told in their bell.
    const bell = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM inbox_notifications WHERE account_id = $1 AND kind = 'partnership.received'`,
      [w.specialist.id],
    );
    expect(bell.rows[0]?.['n']).toBe(1);

    // Only a reviewer reviews; the center is registered as a draft.
    expect(
      (
        await w.staff(manager, 'POST', `/catalog/partnership-requests/${id}/review`, {
          identifier: nationalId(),
          note: 'مدارک کامل است',
        })
      ).status,
    ).toBe(403);
    const reviewed = await w.staff(
      w.specialist,
      'POST',
      `/catalog/partnership-requests/${id}/review`,
      {
        identifier: nationalId(),
        licenseNumber: '۱۲۳/ب',
        note: 'مدارک کامل است',
      },
    );
    expect(reviewed.status).toBe(200);
    expect(reviewed.body['status']).toBe('reviewed');
    const centerId = reviewed.body['centerId'] as string;
    const center = await h.owner.query<Row>('SELECT status, name FROM centers WHERE id = $1', [
      centerId,
    ]);
    expect(center.rows[0]).toMatchObject({ status: 'draft', name: 'کلینیک همکار تازه' });

    // The approval is never the reviewer's (the database refuses it too).
    const self = await w.staff(
      w.specialist,
      'POST',
      `/catalog/partnership-requests/${id}/approve`,
      {
        note: 'تأیید',
      },
    );
    expect(self.status).toBe(403);
    const approved = await w.staff(manager, 'POST', `/catalog/partnership-requests/${id}/approve`, {
      note: 'همکاری تأیید شد',
    });
    expect(approved.status).toBe(200);
    expect(approved.body['status']).toBe('approved');
    const accountId = approved.body['accountId'] as string;
    const account = await h.owner.query<Row>(
      `SELECT kind, username, mobile, mobile_verified_at IS NOT NULL AS verified FROM user_accounts WHERE id = $1`,
      [accountId],
    );
    expect(account.rows[0]).toMatchObject({
      kind: 'center',
      username: `c${String(number)}`,
      mobile,
      verified: true,
    });
    const roles = await h.owner.query<Row>(
      `SELECT r.code, a.scope_kind FROM role_assignments a JOIN roles r ON r.id = a.role_id
       WHERE a.account_id = $1 AND a.revoked_at IS NULL`,
      [accountId],
    );
    expect(roles.rows).toEqual([{ code: 'center_manager', scope_kind: 'center' }]);
    // Still a draft: activation is the two-person path of doc 08.
    expect(
      (await h.owner.query<Row>('SELECT status FROM centers WHERE id = $1', [centerId])).rows[0],
    ).toMatchObject({ status: 'draft' });

    // The link went by the unrecorded SMS only; the token is kept as a hash.
    const sms = links.sent.find((s) => s.mobile === mobile);
    const token = /\/setup#([A-Za-z0-9_-]+)/.exec(sms?.text ?? '')?.[1] ?? '';
    expect(token).toHaveLength(43);
    expect(sms?.text).toContain(`c${String(number)}`);
    expect(await smsOf(mobile)).toEqual(['partnership.received']);
    const stored = await h.owner.query<Row>(
      'SELECT token_hash FROM account_setup_tokens WHERE account_id = $1',
      [accountId],
    );
    expect(stored.rows[0]?.['token_hash']).not.toBe(token);
    const anywhere = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM sms_dispatches WHERE text LIKE $1`,
      [`%${token}%`],
    );
    expect(anywhere.rows[0]?.['n']).toBe(0);

    const check = await json('/auth/setup/check', { token });
    expect(check.status).toBe(200);
    expect(check.body['username']).toBe(`c${String(number)}`);
    const weak = await json('/auth/setup/password', { token, password: '123456789012' });
    expect(weak.status).toBe(400);
    const set = await json('/auth/setup/password', { token, password: 'Kh0sh-Amadid!Sepehr' });
    expect(set.status).toBe(200);
    const again = await json('/auth/setup/password', { token, password: 'Kh0sh-Amadid!Sepehr2' });
    expect(again.status).toBe(410);
    // The password signs in; the authenticator app comes next (rule 25).
    const login = await json('/auth/staff/login', {
      username: `c${String(number)}`,
      password: 'Kh0sh-Amadid!Sepehr',
      client: 'mobile',
    });
    expect(login.status).toBe(200);
    expect(login.body['stage']).toBe('mfa_pending');

    expect(
      (await h.owner.query<Row>('SELECT count(*)::int AS n FROM ledger_entries')).rows[0]?.['n'],
    ).toBe(ledger);
  });

  it('refuses a bot: no proof, a replayed proof, the hidden field, a wrong code, a missing file', async () => {
    const mobile = newMobile();
    const noProof = await json('/catalog/partnership/code', {
      mobile,
      proof: { challenge: 'x'.repeat(20), counter: 1 },
    });
    expect(noProof.status).toBe(400);
    expect(noProof.body['error']).toBe('proof_of_work_invalid');
    const p = await proof();
    expect((await json('/catalog/partnership/code', { mobile, proof: p })).status).toBe(202);
    const replay = await json('/catalog/partnership/code', { mobile, proof: p });
    expect(replay.body['error']).toBe('proof_of_work_invalid');

    // The hidden field filled: answered as sent, and nothing sent.
    const bot = newMobile();
    const before = h.sms.sent.length;
    const fake = await json('/catalog/partnership/code', {
      mobile: bot,
      proof: await proof(),
      website: 'http://spam.example',
    });
    expect(fake.status).toBe(202);
    expect(h.sms.sent.length).toBe(before);

    const otp = h.sms.lastCodeFor(mobile);
    const filled = await submit(request(mobile, otp, { website: 'x' }));
    expect(filled.body['error']).toBe('request_refused');
    const missing = await submit(request(mobile, otp), ['license']);
    expect(missing.body).toMatchObject({ error: 'document_required', kind: 'owner_id' });
    const wrong = await submit(request(mobile, otp === '000000' ? '111111' : '000000'));
    expect(wrong.status).toBe(401);
  });

  it('is rejected with a reason, told by SMS, and stays decided', async () => {
    const mobile = newMobile();
    const sent = await submit(request(mobile, await code(mobile), { centerName: 'مطب ردشدنی' }));
    const queue = await w.staff(w.specialist, 'GET', '/catalog/partnership-requests');
    const id = (queue.body as unknown as Body[]).find((r) => r['number'] === sent.body['number'])?.[
      'id'
    ] as string;
    const rejected = await w.staff(
      w.specialist,
      'POST',
      `/catalog/partnership-requests/${id}/reject`,
      {
        reason: 'پروانه فعالیت خوانا نیست',
      },
    );
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      rejectionReason: 'پروانه فعالیت خوانا نیست',
    });
    expect(await smsOf(mobile)).toEqual(['partnership.received', 'partnership.rejected']);
    const later = await w.staff(manager, 'POST', `/catalog/partnership-requests/${id}/reject`, {
      reason: 'دوباره',
    });
    expect(later.status).toBe(409);
    // The database keeps what was sent.
    await expect(
      h.owner.query(`UPDATE partnership_requests SET center_name = 'دیگر' WHERE id = $1`, [id]),
    ).rejects.toThrow(/does not change/);
  });

  it('survives a failed SMS: the approval is tried again, the same account gets a new link', async () => {
    const mobile = newMobile();
    const sent = await submit(
      request(mobile, await code(mobile), { centerName: 'مطب پیامک دیرکرد' }),
    );
    const queue = await w.staff(w.specialist, 'GET', '/catalog/partnership-requests');
    const id = (queue.body as unknown as Body[]).find((r) => r['number'] === sent.body['number'])?.[
      'id'
    ] as string;
    await w.staff(w.specialist, 'POST', `/catalog/partnership-requests/${id}/review`, {
      identifier: nationalId(),
      note: 'مدارک کامل است',
    });
    links.failNext = true;
    const failed = await w.staff(manager, 'POST', `/catalog/partnership-requests/${id}/approve`, {
      note: 'تأیید',
    });
    expect(failed.status).toBe(500);
    const after = await w.staff(manager, 'GET', `/catalog/partnership-requests/${id}`);
    expect(after.body['status']).toBe('reviewed');
    const again = await w.staff(manager, 'POST', `/catalog/partnership-requests/${id}/approve`, {
      note: 'تأیید دوباره',
    });
    expect(again.status).toBe(200);
    const accounts = await h.owner.query<Row>('SELECT id FROM user_accounts WHERE username = $1', [
      `c${String(sent.body['number'])}`,
    ]);
    expect(accounts.rows).toHaveLength(1);
    const token = /\/setup#([A-Za-z0-9_-]+)/.exec(
      links.sent.filter((s) => s.mobile === mobile).at(-1)?.text ?? '',
    )?.[1];
    expect((await json('/auth/setup/check', { token })).status).toBe(200);
  });
});
