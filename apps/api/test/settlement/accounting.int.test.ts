import { randomUUID } from 'node:crypto';
import { addJalaliMonths, gregorianDayOf, statementPeriod, toJalali } from '@sepehr/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EffectiveAccess } from '../../src/common/auth/access.port';
import { CLI_ACTOR } from '../../src/common/auth/actor';
import { AccountingService, odooExternalId } from '../../src/modules/settlement/accounting.service';
import { SettlementService } from '../../src/modules/settlement/settlement.service';
import { StatementService } from '../../src/modules/settlement/statement.service';
import { startHarness, type Harness, type loggedInAccount } from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 5-7 (doc 06 §7; doc 14 ث and 5-7 acceptance; owner 5.5): accounting's reports of held
 * items and negative balances, and the Odoo export of a month's documents: the same external
 * ids however often it is made; its totals the ledger's for that month; ISO date for Odoo
 * with the Jalali one beside it; an unmapped account refuses the file.
 */

type Staff = Awaited<ReturnType<typeof loggedInAccount>>;

const BOM = String.fromCharCode(0xfeff);

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let finance: Staff;
let finance2: Staff;
let advisor: Staff;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  finance = await w.role('accounting');
  finance2 = await w.role('accounting');
  advisor = await w.role('advisor');
}, 180_000);

afterAll(async () => {
  await h.close();
});

const settlement = () => h.app.get(SettlementService);
const statements = () => h.app.get(StatementService);
const accounting = () => h.app.get(AccountingService);

/** Accounting's access, for what only the service can be asked (a month already over). */
const ACCOUNTING: EffectiveAccess = {
  accountId: randomUUID(),
  roles: ['accounting'],
  permissions: new Set(['settlement.manage_odoo_mapping', 'settlement.read_reports']),
  scopes: [{ kind: 'global' }],
};

async function setRate(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2, now(), 'approved', 'آزمون', now())`,
    [key, JSON.stringify(value)],
  );
}

/** A doctor of their own with one cash service declared (a fixed fee), due next month. */
async function cashDoctor(feeRial: string) {
  const world = await creditWorld(h);
  const { patient } = await world.inReview();
  const { rows } = await h.owner.query<Row>(
    `SELECT r.id FROM referrals r JOIN user_accounts a ON a.person_id = r.person_id
     WHERE a.id = $1 ORDER BY r.referred_at DESC LIMIT 1`,
    [patient.id],
  );
  await setRate('settlement.cash_service_fee', { basis: 'fixed', rial: feeRial });
  let made;
  try {
    made = await world.staff(world.doctor, 'POST', '/settlement/cash-services', {
      referralId: rows[0]?.['id'],
      serviceDate: gregorianDayOf(toJalali(new Date())),
      amountRial: '4000000',
      idempotencyKey: `cash-${randomUUID()}`,
    });
  } finally {
    await setRate('settlement.cash_service_fee', { basis: 'percent', bps: 0 });
  }
  const feeId = (made.body['fee'] as Body)['id'] as string;
  const fee = await h.owner.query<Row>('SELECT doctor_id, due_at FROM service_fees WHERE id = $1', [
    feeId,
  ]);
  const dueAt = fee.rows[0]?.['due_at'] as Date;
  await settlement().markDue(dueAt);
  return { world, feeId, doctorId: fee.rows[0]?.['doctor_id'] as string, dueAt };
}

const monthOf = (at: Date) => {
  const j = toJalali(at);
  return { year: j.year, month: j.month };
};

describe("accounting's reports and the Odoo export (task 5-7)", () => {
  it('negative balances: two statements in a row flagged (the configured 2), one is not', async () => {
    const twice = await cashDoctor('300000');
    const p = monthOf(twice.dueAt);
    await statements().generateFor(CLI_ACTOR, twice.doctorId, p.year, p.month);
    const after = addJalaliMonths({ year: p.year, month: p.month, day: 1 }, 1);
    // Next month: nothing new, what was carried is carried again.
    await statements().generateFor(CLI_ACTOR, twice.doctorId, after.year, after.month);
    const once = await cashDoctor('200000');
    await statements().generateFor(CLI_ACTOR, once.doctorId, p.year, p.month);

    const report = await w.staff(finance, 'GET', '/settlement/reports/negative');
    expect(report.status).toBe(200);
    const rows = report.body as unknown as Body[];
    expect(rows.find((r) => r['doctorId'] === twice.doctorId)).toMatchObject({
      periods: 2,
      alert: true,
      carriedOutRial: '300000',
      periodYear: after.year,
      periodMonth: after.month,
      providerName: 'دکتر اعتبار',
    });
    expect(rows.find((r) => r['doctorId'] === once.doctorId)).toMatchObject({
      periods: 1,
      alert: false,
    });
    expect((await w.staff(advisor, 'GET', '/settlement/reports/negative')).status).toBe(403);
    expect((await w.staff(w.doctor, 'GET', '/settlement/reports/negative')).status).toBe(403);
  });

  it('held items: each one under dispute, with its dispute', async () => {
    const d = await cashDoctor('100000');
    const opened = await d.world.staff(d.world.doctor, 'POST', '/settlement/disputes', {
      subjectType: 'service_fee',
      subjectId: d.feeId,
      reason: 'این کارمزد درست نیست',
    });
    expect(opened.status).toBe(201);
    const held = (await w.staff(finance, 'GET', '/settlement/reports/held'))
      .body as unknown as Body[];
    expect(held.find((r) => r['itemId'] === d.feeId)).toMatchObject({
      kind: 'cash_fee',
      amountRial: '100000',
      disputeId: opened.body['id'],
      disputeStatus: 'open',
      providerName: 'دکتر اعتبار',
    });
  });

  it('the Odoo export: unmapped refused; then the same external ids each time, totals = the ledger, ISO and Jalali dates', async () => {
    // A draft made and cancelled by two: an offset and its reversal in the books.
    await setRate('settlement.cash_service_fee', { basis: 'percent', bps: 0 });
    const d = await cashDoctor('500000');
    const p = monthOf(d.dueAt);
    const draft = (await statements().generateFor(CLI_ACTOR, d.doctorId, p.year, p.month))
      ?.statementId as string;
    for (const who of [finance, finance2]) {
      await w.staff(who, 'POST', `/settlement/statements/${draft}/cancel`, { reason: 'آزمون' });
    }

    // The month the documents were posted in, as if it were over.
    const posted = monthOf(new Date());
    const over = new Date(statementPeriod(posted.year, posted.month).end.getTime() + 60_000);
    const refused = accounting().export(CLI_ACTOR, ACCOUNTING, posted.year, posted.month, over);
    await expect(refused).rejects.toMatchObject({ response: { error: 'odoo_mapping_missing' } });
    const codes = await refused.then(
      () => [] as string[],
      (e: unknown) => (e as { response: { codes: string[] } }).response.codes,
    );
    expect(codes.length).toBeGreaterThan(0);
    // Not over yet: refused.
    await expect(
      accounting().export(CLI_ACTOR, ACCOUNTING, posted.year, posted.month, new Date()),
    ).rejects.toMatchObject({ response: { error: 'period_not_over' } });

    // Mapped from the panel, by accounting; the doctor never.
    expect(
      (
        await w.staff(w.doctor, 'POST', '/settlement/odoo/mappings', {
          internalCode: codes[0],
          odooAccountCode: '1000',
          reason: 'نگاشت آزمون',
        })
      ).status,
    ).toBe(403);
    for (const [i, code] of codes.entries()) {
      const set = await w.staff(finance, 'POST', '/settlement/odoo/mappings', {
        internalCode: code,
        odooAccountCode: String(2100 + i),
        reason: 'نگاشت آزمون',
      });
      expect(set.status).toBe(201);
    }

    const first = await accounting().export(CLI_ACTOR, ACCOUNTING, posted.year, posted.month, over);
    const second = await accounting().export(
      CLI_ACTOR,
      ACCOUNTING,
      posted.year,
      posted.month,
      over,
    );
    const rowsOf = (csv: string) =>
      csv
        .replace(BOM, '')
        .trim()
        .split('\r\n')
        .map((l) => l.split(','));
    const [header, ...lines] = rowsOf(first.csv ?? '');
    expect(header).toEqual([
      'external_id',
      'line_id',
      'date',
      'date_jalali',
      'journal_ref',
      'account',
      'internal_account',
      'partner_ref',
      'debit',
      'credit',
    ]);
    // Exported again: the very same ids, none new and none twice.
    const ids = (csv: string) =>
      rowsOf(csv)
        .slice(1)
        .map((l) => l[1]);
    expect(ids(second.csv ?? '')).toEqual(ids(first.csv ?? ''));
    expect(new Set(ids(first.csv ?? '')).size).toBe(lines.length);
    expect(first.documents).toBe(second.documents);

    // The file's totals are the ledger's for that month (acceptance).
    const { start, end } = statementPeriod(posted.year, posted.month);
    const { rows } = await h.owner.query<Row>(
      `SELECT count(DISTINCT j.id)::int AS documents,
              sum(e.amount_rial) FILTER (WHERE e.direction = 'debit')::text AS debit,
              sum(e.amount_rial) FILTER (WHERE e.direction = 'credit')::text AS credit
       FROM journal_entries j JOIN ledger_entries e ON e.journal_entry_id = j.id
       WHERE j.entity_id = 'aramesh' AND j.occurred_at >= $1 AND j.occurred_at < $2`,
      [start, end],
    );
    expect(first).toMatchObject({
      documents: rows[0]?.['documents'],
      debitTotalRial: rows[0]?.['debit'],
      creditTotalRial: rows[0]?.['credit'],
    });
    const sum = (col: number) => lines.reduce((s, l) => s + BigInt(l[col] ?? '0'), 0n);
    expect(sum(8).toString()).toBe(rows[0]?.['debit']);
    expect(sum(9).toString()).toBe(rows[0]?.['credit']);

    // ISO for Odoo, the Jalali day beside it; the reversal names what it reverses.
    for (const l of lines) {
      expect(l[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(l[3]).toMatch(/^14\d\d\/\d{2}\/\d{2}$/);
    }
    const { rows: reversal } = await h.owner.query<Row>(
      `SELECT j.id, j.reverses_journal_entry_id FROM journal_entries j
       JOIN settlement_statements s ON s.cancel_journal_entry_id = j.id WHERE s.id = $1`,
      [draft],
    );
    const reversed = reversal[0]?.['reverses_journal_entry_id'] as string | undefined;
    if (reversed) {
      expect(first.csv).toContain(`${odooExternalId(reversal[0]?.['id'] as string)},`);
      expect(first.csv).toContain(`reverses ${odooExternalId(reversed)}`);
    }
    // No name or national code; no VAT column.
    expect(first.csv).not.toContain('دکتر اعتبار');
    expect(header).not.toContain('vat');

    const history = (await w.staff(finance, 'GET', '/settlement/odoo/exports'))
      .body as unknown as Body[];
    expect(history.filter((e) => e['periodMonth'] === posted.month).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(history[0]).not.toHaveProperty('csv');
  });
});
