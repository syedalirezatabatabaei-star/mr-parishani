import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { writeSheet } from '../../src/common/xlsx';
import { RepaymentService } from '../../src/modules/repayment/repayment.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';
import { grantRole, loggedInAccount, newIp, startHarness, type Harness } from '../identity/harness';
import { CREDIT_HARNESS } from '../credit/world';
import { scheduleVersionsNow } from './rounding-version';

/**
 * Task 6-3 (doc 15 §2; owner 1405/07/15): a bank statement imported through a mapping chosen
 * by its uploader (rials unless said, a few rows and the sum before it is confirmed, the
 * last mapping offered next time); each row suggests a slip or is an unknown deposit. The
 * acceptance: nothing is posted and no slip moves; the same file again is the same import;
 * Persian and Arabic digits read; a harmful file refused.
 */

type Row = Record<string, unknown>;
type Body = Record<string, unknown>;

let h: Harness;
let wallet: WalletService;
let repayment: RepaymentService;
let accounting: Awaited<ReturnType<typeof loggedInAccount>>;
let advisor: Awaited<ReturnType<typeof loggedInAccount>>;
let scheduleId: string;
const M = 1_000_000n;

beforeAll(async () => {
  // The fake scanner and storage (the file is scanned and kept, rule 28).
  h = await startHarness(CREDIT_HARNESS);
  wallet = h.app.get(WalletService);
  repayment = h.app.get(RepaymentService);
  accounting = await loggedInAccount(h, 'staff');
  await grantRole(h, accounting.id, 'accounting');
  advisor = await loggedInAccount(h, 'staff');
  await grantRole(h, advisor.id, 'advisor');
  const approved = await wallet.approveCredit(CLI_ACTOR, {
    idempotencyKey: `bs:approve:${randomUUID()}`,
    caseId: randomUUID(),
    borrowerPersonId: randomUUID(),
    amountRial: 12n * M,
    scope: { centerNodeId: randomUUID(), doctorNodeId: randomUUID(), treatmentFieldCode: 'dental' },
  });
  await wallet.charge(CLI_ACTOR, approved.purseId, { idempotencyKey: `bs:charge:${randomUUID()}` });
  scheduleId = (
    await repayment.createSchedule(CLI_ACTOR, {
      idempotencyKey: `bs:schedule:${randomUUID()}`,
      purseId: approved.purseId,
      installmentCount: 6,
      planFeeRial: 0n,
      ...(await scheduleVersionsNow(h)),
    })
  ).scheduleId;
});

afterAll(async () => {
  await h.close();
});

/** A slip as staff enter it: its bank reference and day (task 6-2's columns). */
async function slip(amount: bigint, reference: string, paidOn: string) {
  return (
    await repayment.registerReceipt(CLI_ACTOR, {
      idempotencyKey: `bs:receipt:${randomUUID()}`,
      scheduleId,
      amountRial: amount,
      receivedAt: new Date(),
      reference,
      paidOn,
    })
  ).paymentId;
}

async function send(
  path: string,
  who: { access: string },
  file: Uint8Array | Buffer,
  map?: Body,
  name = 'statement.xlsx',
) {
  const form = new FormData();
  if (map) form.append('map', JSON.stringify(map));
  form.append('file', new Blob([new Uint8Array(file)]), name);
  const res = await fetch(`${h.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.access}`, 'x-forwarded-for': newIp() },
    body: form,
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const counts = async () =>
  (
    await h.owner.query<Row>(
      `SELECT (SELECT count(*)::int FROM journal_entries) AS journals,
              (SELECT count(*)::int FROM payment_allocations) AS allocations,
              (SELECT string_agg(id::text || ':' || status, ',' ORDER BY id) FROM payments) AS payments`,
    )
  ).rows[0];

const MAP = {
  dateColumn: 0,
  amountColumn: 1,
  refColumn: 2,
  descriptionColumn: 3,
  amountUnit: 'rial',
  headerRow: true,
};

describe('bank statements (task 6-3)', () => {
  it('preview: a few rows and the sum through the mapping, tomans when said; nothing kept', async () => {
    const file = writeSheet([
      ['تاریخ', 'مبلغ', 'پیگیری', 'شرح'],
      ['۱۴۰۵/۰۷/۱۰', '۲۵۰٬۰۰۰', 'A-1', 'واریز'],
      ['١٤٠٥/٠٧/١١', '١٠٠', 'A-2', ''],
    ]);
    const plain = await send('/repayment/bank-statements/preview', accounting, file);
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body).toMatchObject({ headers: ['تاریخ', 'مبلغ', 'پیگیری', 'شرح'], mapped: null });
    expect((plain.body['sampleRows'] as unknown[]).length).toBe(2);

    const tomans = await send('/repayment/bank-statements/preview', accounting, file, {
      ...MAP,
      amountUnit: 'toman',
    });
    expect(tomans.body['mapped']).toMatchObject({
      totalRial: '2501000',
      validRows: 2,
      invalidRows: 0,
      rows: [
        { rowNo: 2, paidOn: '2026-10-02', amountRial: '2500000', bankRef: 'A-1', invalid: null },
        { rowNo: 3, paidOn: '2026-10-03', amountRial: '1000', bankRef: 'A-2', invalid: null },
      ],
    });
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM bank_statement_imports',
    );
    expect(rows[0]?.['n']).toBe(0);
  });

  it('acceptance: suggestions, an unknown deposit, an invalid row; nothing posted and no slip moved; the same file once', async () => {
    const ref = `TRK${String(Date.now()).slice(-6)}`;
    const exact = await slip(3n * M, ref, '2026-10-02');
    const probable = await slip(700_000n, 'OTHER-1', '2026-10-04');
    const before = await counts();

    const persianRef = ref.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)] ?? d);
    const file = writeSheet([
      ['تاریخ', 'مبلغ', 'پیگیری', 'شرح'],
      ['۱۴۰۵/۰۷/۱۰', '۳٬۰۰۰٬۰۰۰', persianRef, 'واریز قسط'],
      ['1405/07/13', '700,000', 'BANK-XYZ', 'واریز'],
      ['1405/07/14', '999,000', 'NOPE', 'ناشناس'],
      ['1405/07/14', 'مبلغ ندارد', 'X', ''],
    ]);
    const made = await send('/repayment/bank-statements', accounting, file, MAP);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({
      rows: 4,
      totalRial: '4699000',
      matches: { exact: 1, probable: 1, none: 1, invalid: 1 },
      replayed: false,
    });
    const id = made.body['id'] as string;
    const rows = (await (
      await fetch(`${h.baseUrl}/repayment/bank-statements/${id}/rows`, {
        headers: { authorization: `Bearer ${accounting.access}`, 'x-forwarded-for': newIp() },
      })
    ).json()) as Body[];
    expect(rows.map((r) => [r['rowNo'], r['matchKind'], r['suggestedPaymentId']])).toEqual([
      [2, 'exact', exact],
      [3, 'probable', probable],
      [4, 'none', null],
      [5, 'invalid', null],
    ]);

    // Nothing posted, no allocation, no slip's status changed.
    expect(await counts()).toEqual(before);

    // The same file again: the same import, nothing new.
    const again = await send('/repayment/bank-statements', accounting, file, MAP);
    expect(again.body).toMatchObject({ id, replayed: true });
    const { rows: imports } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM bank_statement_imports',
    );
    expect(imports[0]?.['n']).toBe(1);
    expect(await counts()).toEqual(before);

    // The mapping is offered for the next file.
    const next = await send('/repayment/bank-statements/preview', accounting, writeSheet([['a']]));
    expect(next.body['suggestedMap']).toEqual(MAP);
  });

  it('a CSV with Arabic digits; a harmful file and a file that is no sheet refused', async () => {
    const csv = Buffer.from('date,amount,ref\n١٤٠٥/٠٧/٢٠,"٤٥٠,٠٠٠",C-1\n', 'utf8');
    const read = await send(
      '/repayment/bank-statements/preview',
      accounting,
      csv,
      { dateColumn: 0, amountColumn: 1, refColumn: 2, descriptionColumn: null },
      'statement.csv',
    );
    expect(read.body['mapped']).toMatchObject({
      totalRial: '450000',
      rows: [{ paidOn: '2026-10-12', amountRial: '450000', bankRef: 'C-1' }],
    });

    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const infected = await send('/repayment/bank-statements', accounting, eicar, MAP, 'x.csv');
    expect(infected.status).toBe(400);
    expect(infected.body['error']).toBe('file_infected');
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    const refused = await send('/repayment/bank-statements', accounting, binary, MAP, 'x.png');
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toBe('unsupported_type');
    const { rows } = await h.owner.query<Row>(
      'SELECT count(*)::int AS n FROM bank_statement_imports',
    );
    expect(rows[0]?.['n']).toBe(1);
  });

  it('a row reviewed once, with a note; accounting only', async () => {
    const { rows } = await h.owner.query<Row>(
      "SELECT id FROM bank_statement_rows WHERE match_kind = 'none' LIMIT 1",
    );
    const id = rows[0]?.['id'] as string;
    const review = (who: { access: string }, note: string) =>
      fetch(`${h.baseUrl}/repayment/bank-statements/rows/${id}/review`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${who.access}`,
          'content-type': 'application/json',
          'x-forwarded-for': newIp(),
        },
        body: JSON.stringify({ note }),
      });
    expect((await review(advisor, 'نگاه شد')).status).toBe(403);
    const done = await review(accounting, 'واریز شخص ثالث؛ پیگیری با بانک');
    expect(done.status).toBe(201);
    expect(((await done.json()) as Body)['reviewNote']).toBe('واریز شخص ثالث؛ پیگیری با بانک');
    // Once: a second note does not replace the first.
    await review(accounting, 'دوباره');
    const { rows: after } = await h.owner.query<Row>(
      'SELECT review_note FROM bank_statement_rows WHERE id = $1',
      [id],
    );
    expect(after[0]?.['review_note']).toBe('واریز شخص ثالث؛ پیگیری با بانک');
    expect(
      (await send('/repayment/bank-statements/preview', advisor, writeSheet([['a']]))).status,
    ).toBe(403);
  });
});
