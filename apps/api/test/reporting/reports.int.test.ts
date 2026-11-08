import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_PORT, type AccessPort } from '../../src/common/auth/access.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/common/storage/object-storage.port';
import type { ReportDefinition } from '../../src/modules/reporting/report-definition';
import { pdfHtml } from '../../src/modules/reporting/report-files';
import { ReportRegistry } from '../../src/modules/reporting/report-registry';
import { ReportService } from '../../src/modules/reporting/report.service';
import {
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 7-3 (doc 17 §2, §4, §5; §9 tests 5, 6, 8 and 9; docs/decisions/task-7-3-decisions.md):
 * a report runs on the read-only reporting connection only; an export is exactly what the page
 * shows, for two roles alike; the CSV opens right in Persian Excel; every export is recorded and
 * an encrypted field is masked unless allowed with a reason. Besides: the background export, the
 * PDF, and saved filters with relative ranges and sharing.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let support: LoggedInAccount;
let accounting: LoggedInAccount;
let manager: LoggedInAccount;

const storage = () => h.app.get<ObjectStorage>(OBJECT_STORAGE);

/** Test-only definitions: what the tickets report has no column for. */
const any = z.strictObject({});
const probe = (
  code: string,
  columns: ReportDefinition['columns'],
  statement: ReportDefinition['statement'],
  reveal?: ReportDefinition['reveal'],
): ReportDefinition => ({
  code,
  title: `آزمون ${code}`,
  permissions: ['reporting.run'],
  params: any,
  views: [],
  columns,
  scope: () => sql`true`,
  statement,
  ...(reveal ? { reveal } : {}),
});

async function csvOfExport(who: LoggedInAccount, code: string, body: Body = {}) {
  const made = await w.staff(who, 'POST', `/reporting/reports/${code}/exports`, {
    format: 'csv',
    ...body,
  });
  expect(made.status).toBe(201);
  expect(made.body['status']).toBe('ready');
  const { rows } = await h.owner.query<Row>('SELECT object_key FROM report_exports WHERE id = $1', [
    made.body['id'],
  ]);
  const file = await storage().get('private', rows[0]?.['object_key'] as string);
  return { id: made.body['id'] as string, file };
}

/** The CSV's rows of cells (quoted, CRLF), without the BOM. */
const parse = (file: Buffer) =>
  file
    .subarray(3)
    .toString('utf8')
    .trimEnd()
    .split('\r\n')
    .map((line) =>
      [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => (m[1] ?? '').replace(/""/g, '"')),
    );

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  support = await w.role('support');
  accounting = await w.role('accounting');
  manager = await w.role('strategy_manager');
  for (const [queueCode, who] of [
    ['ticket_support', support],
    ['ticket_accounting', accounting],
  ] as const) {
    await w.staff(manager, 'PUT', '/lead/assignment/shares', {
      queueCode,
      shares: [{ accountId: who.id, percent: 100 }],
      reason: 'سهم صف تیکت',
    });
  }
  for (const topicCode of ['general', 'appointment', 'payment']) {
    const p = await w.patient();
    const made = await w.as(p, 'POST', '/me/tickets', {
      topicCode,
      subject: `پرسش ${topicCode}`,
      body: 'متن پرسش',
      links: [],
    });
    expect(made.status).toBe(201);
  }
  const registry = h.app.get(ReportRegistry);
  registry.register(
    probe(
      'probe_connection',
      [{ key: 'who', title: 'کاربر', kind: 'text' }],
      () => sql`SELECT current_user::text AS who`,
    ),
  );
  registry.register(
    probe(
      'probe_write',
      [{ key: 'id', title: 'شناسه', kind: 'text' }],
      () => sql`UPDATE tickets SET status = status RETURNING id::text AS id`,
    ),
  );
  registry.register(
    probe(
      'probe_cells',
      [
        { key: 'amount', title: 'مبلغ', kind: 'rial' },
        { key: 'day', title: 'روز', kind: 'date' },
        { key: 'note', title: 'یادداشت', kind: 'text' },
        { key: 'nationalId', title: 'کد ملی', kind: 'text', sensitive: true },
        { key: 'doctorName', title: 'پزشک', kind: 'text' },
      ],
      () => sql`
        SELECT * FROM (VALUES
          ('12345', '2026-10-08', '=HYPERLINK("x")', '••••••5678', 'دکتر آزمون'),
          ('20', '2026-10-07', 'ساده', '••••••4321', 'دکتر دو')
        ) AS v(amount, day, note, "nationalId", "doctorName")
      `,
      // The owning module's port would decrypt; here, the whole values.
      () => Promise.resolve([{ nationalId: '0012345678' }, { nationalId: '0098764321' }]),
    ),
  );
}, 300_000);

afterAll(async () => {
  await h.close();
});

describe('test 6: no report query runs on the operational connection', () => {
  it('runs as sepehr_report, which cannot write', async () => {
    const ran = await w.staff(manager, 'POST', '/reporting/reports/probe_connection/run', {});
    expect(ran.status).toBe(200);
    expect((ran.body['rows'] as Body[])[0]).toEqual({ who: 'sepehr_report' });
    // Drizzle wraps the database's refusal; the refusal itself is its cause.
    await expect(
      h.app.get(ReportService).run(await accessOf(manager), 'probe_write', {}),
    ).rejects.toSatisfy((error: { cause?: { message?: string } }) =>
      /permission denied/.test(error.cause?.message ?? ''),
    );
  });
});

async function accessOf(who: LoggedInAccount) {
  return h.app.get<AccessPort>(ACCESS_PORT).resolve(who.id);
}

describe('test 5: an export is exactly what the page shows, for each role', () => {
  it('support sees their unit without who has it; a manager all, with it; the CSV alike', async () => {
    for (const [who, units, assignee] of [
      [support, ['support'], false],
      [manager, ['support', 'accounting'], true],
    ] as const) {
      const ran = await w.staff(who, 'POST', '/reporting/reports/tickets/run', {
        params: { range: { relative: 'today' } },
      });
      expect(ran.status).toBe(200);
      const columns = ran.body['columns'] as Body[];
      const rows = ran.body['rows'] as Body[];
      expect(columns.some((c) => c['key'] === 'assignee')).toBe(assignee);
      expect(new Set(rows.map((r) => r['unit']))).toEqual(new Set(units));
      const { file } = await csvOfExport(who, 'tickets', {
        params: { range: { relative: 'today' } },
      });
      const [header, ...cells] = parse(file);
      expect(header).toEqual(columns.map((c) => c['title']));
      expect(cells.map((c) => c[0])).toEqual(rows.map((r) => String(r['number'])));
      expect(cells.map((c) => c[columns.findIndex((x) => x['key'] === 'status')])).toEqual(
        rows.map((r) => r['status']),
      );
    }
  });
});

describe('test 8: the CSV opens right in Persian Excel', () => {
  it('a BOM, Jalali dates, ASCII digits, the money unit in its header, formulas defused', async () => {
    const { file } = await csvOfExport(manager, 'probe_cells', { moneyUnit: 'toman' });
    expect([...file.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [header, first, second] = parse(file);
    expect(header).toEqual(['مبلغ (تومان)', 'روز', 'یادداشت', 'کد ملی']);
    expect(first).toEqual(['1234.5', '1405/07/16', `'=HYPERLINK("x")`, '••••••5678']);
    expect(second?.[0]).toBe('2');
    const tickets = parse((await csvOfExport(manager, 'tickets')).file);
    const at = tickets[0]?.indexOf('زمان ثبت') ?? -1;
    expect(tickets[1]?.[at]).toMatch(/^14\d\d\/\d\d\/\d\d \d\d:\d\d$/);
  });
});

describe('test 9: every export recorded; an encrypted field masked unless allowed', () => {
  it('a record and an event each; the whole value only with the permission and a reason', async () => {
    const { id } = await csvOfExport(manager, 'probe_cells');
    const { rows } = await h.owner.query<Row>('SELECT * FROM report_exports WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({
      account_id: manager.id,
      report_code: 'probe_cells',
      format: 'csv',
      row_count: 2,
      sensitive: false,
      status: 'ready',
    });
    const events = await h.owner.query<Row>(
      `SELECT payload FROM outbox_events WHERE event_type = 'report.exported' AND aggregate_id = $1`,
      [id],
    );
    expect(events.rows[0]?.['payload']).toMatchObject({
      exportId: id,
      rowCount: 2,
      sensitive: false,
    });

    // The page: masked, and the doctor's name stripped for who may not see treatment.
    const page = await w.staff(manager, 'POST', '/reporting/reports/probe_cells/run', {});
    expect((page.body['rows'] as Body[])[0]).toMatchObject({ nationalId: '••••••5678' });
    expect((page.body['columns'] as Body[]).map((c) => c['key'])).not.toContain('doctorName');

    // Without the permission, refused; without a reason, refused.
    const refused = await w.staff(manager, 'POST', '/reporting/reports/probe_cells/exports', {
      format: 'csv',
      sensitive: { reason: 'بررسی حسابرسی' },
    });
    expect(refused.status).toBe(403);
    await h.owner.query(
      `INSERT INTO roles (code, name, is_system) VALUES ('test_sensitive', 'آزمون', false)`,
    );
    await h.owner.query(
      `INSERT INTO role_permissions (role_id, permission_code)
       SELECT id, 'reporting.export_sensitive' FROM roles WHERE code = 'test_sensitive'`,
    );
    await grantRole(h, manager.id, 'test_sensitive');
    const noReason = await w.staff(manager, 'POST', '/reporting/reports/probe_cells/exports', {
      format: 'csv',
      sensitive: {},
    });
    expect(noReason.status).toBe(400);
    const { id: whole, file } = await csvOfExport(manager, 'probe_cells', {
      sensitive: { reason: 'بررسی حسابرسی' },
    });
    expect(parse(file)[1]?.[3]).toBe('0012345678');
    const recorded = await h.owner.query<Row>(
      'SELECT sensitive, reason FROM report_exports WHERE id = $1',
      [whole],
    );
    expect(recorded.rows[0]).toEqual({ sensitive: true, reason: 'بررسی حسابرسی' });
    // One's own export only.
    expect((await w.staff(support, 'GET', `/reporting/exports/${whole}/link`)).status).toBe(404);
    expect((await w.staff(manager, 'GET', `/reporting/exports/${whole}/link`)).status).toBe(200);
  });
});

describe('a large export, and every PDF, in the background', () => {
  it('queued above the threshold, then made by the worker; a PDF with its watermark', async () => {
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('reporting.async_export_rows', 'global', '1', now(), 'approved', 'آزمون', now())`,
    );
    const big = await w.staff(manager, 'POST', '/reporting/reports/tickets/exports', {
      format: 'csv',
    });
    expect(big.body).toMatchObject({ status: 'queued', rowCount: null });
    const pdf = await w.staff(manager, 'POST', '/reporting/reports/tickets/exports', {
      format: 'pdf',
    });
    expect(pdf.body).toMatchObject({ status: 'queued' });
    expect(
      (await w.staff(manager, 'GET', `/reporting/exports/${pdf.body['id'] as string}/link`)).status,
    ).toBe(409);

    // As the worker does (its Chromium in production; here a renderer that keeps the page).
    const pages: string[] = [];
    await h.app.get(ReportService).processQueued(new Date(), {
      render: (html) => {
        pages.push(html);
        return Promise.resolve(Buffer.from('%PDF-1.4 test'));
      },
    });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('class="watermark">');
    expect(pages[0]).toContain('شکایات و تیکت');
    const mine = await w.staff(manager, 'GET', '/reporting/exports');
    const byId = new Map((mine.body as unknown as Body[]).map((e) => [e['id'], e]));
    expect(byId.get(big.body['id'])).toMatchObject({ status: 'ready' });
    expect(byId.get(pdf.body['id'])).toMatchObject({ status: 'ready', format: 'pdf' });
    const { rows } = await h.owner.query<Row>(
      'SELECT object_key FROM report_exports WHERE id = $1',
      [pdf.body['id']],
    );
    const file = await storage().get('private', rows[0]?.['object_key'] as string);
    expect(file.subarray(0, 4).toString()).toBe('%PDF');
    await h.owner.query(
      `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
       VALUES ('reporting.async_export_rows', 'global', '5000', now(), 'approved', 'آزمون', now())`,
    );
  }, 180_000);

  it('the PDF’s page: right to left, the filters on top, the watermark of who and when', () => {
    const html = pdfHtml({
      title: 'شکایات و تیکت',
      filters: ['بازه: ۱۴۰۵/۰۷/۰۱ تا ۱۴۰۵/۰۷/۱۶'],
      columns: [{ key: 'n', title: 'شماره', kind: 'int' }],
      rows: [{ n: 1001 }],
      unit: 'rial',
      who: 'کارشناس آزمون',
      at: new Date('2026-10-08T10:00:00Z'),
    });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('class="watermark">کارشناس آزمون — ۱۴۰۵/۰۷/۱۶ ۱۳:۳۰');
    expect(html).toContain('<li>بازه: ۱۴۰۵/۰۷/۰۱ تا ۱۴۰۵/۰۷/۱۶</li>');
    expect(html).toContain('counter(page)');
    expect(html).toContain('<td>۱۰۰۱</td>');
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe('the report list names each report’s parameters (task 7-7)', () => {
  it('for the page’s one filter', async () => {
    const listed = await w.staff(manager, 'GET', '/reporting/reports');
    expect(listed.status).toBe(200);
    const tickets = (listed.body as unknown as Body[]).find((r) => r['code'] === 'tickets');
    expect(tickets?.['params']).toEqual(['range', 'unit', 'status']);
  });

  it('and the ticket topics’ names, for showing a topic code by its name', async () => {
    const named = await w.staff(manager, 'GET', '/reporting/ticket-topics');
    expect(named.status).toBe(200);
    expect(named.body as unknown as Body[]).toContainEqual({
      code: 'general',
      title: expect.any(String) as unknown,
    });
  });
});

describe('saved filters (doc 17 §4)', () => {
  it('relative ranges kept relative; shared only with one’s unit; run with the runner’s scope', async () => {
    const mine = await w.staff(support, 'POST', '/reporting/filters', {
      reportCode: 'tickets',
      name: 'تیکت‌های این ماه',
      conditions: { range: { relative: 'this_month' } },
    });
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({
      conditions: { range: { relative: 'this_month' } },
      mine: true,
    });
    expect(
      (
        await w.staff(support, 'POST', '/reporting/filters', {
          reportCode: 'tickets',
          name: 'اشتراکی',
          conditions: {},
          sharedUnit: 'support',
        })
      ).status,
    ).toBe(403);

    // A manager shares with their own unit only.
    const lead = await loggedInAccount(h, 'staff');
    await grantRole(h, lead.id, 'collection_manager');
    await grantRole(h, lead.id, 'support');
    expect(
      (
        await w.staff(lead, 'POST', '/reporting/filters', {
          reportCode: 'tickets',
          name: 'برای حسابداری',
          conditions: {},
          sharedUnit: 'accounting',
        })
      ).status,
    ).toBe(403);
    const shared = await w.staff(lead, 'POST', '/reporting/filters', {
      reportCode: 'tickets',
      name: 'همه تیکت‌های پشتیبانی',
      conditions: {},
      sharedUnit: 'support',
    });
    expect(shared.status).toBe(201);
    const seen = await w.staff(support, 'GET', '/reporting/filters?reportCode=tickets');
    expect((seen.body as unknown as Body[]).map((f) => [f['name'], f['mine']])).toEqual([
      ['تیکت‌های این ماه', true],
      ['همه تیکت‌های پشتیبانی', false],
    ]);
    const ran = await w.staff(
      support,
      'POST',
      `/reporting/filters/${shared.body['id'] as string}/run`,
      {},
    );
    expect(ran.status).toBe(200);
    expect(new Set((ran.body['rows'] as Body[]).map((r) => r['unit']))).toEqual(
      new Set(['support']),
    );
    const relative = await w.staff(
      support,
      'POST',
      `/reporting/filters/${mine.body['id'] as string}/run`,
      {},
    );
    expect((relative.body['applied'] as Body)['range']).toMatchObject({ relative: 'this_month' });

    // Deleted softly, by its owner only.
    expect(
      (
        await w.staff(
          support,
          'POST',
          `/reporting/filters/${shared.body['id'] as string}/delete`,
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      (await w.staff(support, 'POST', `/reporting/filters/${mine.body['id'] as string}/delete`, {}))
        .status,
    ).toBe(204);
    const kept = await h.owner.query<Row>(
      'SELECT deleted_at IS NOT NULL AS deleted FROM report_saved_filters WHERE id = $1',
      [mine.body['id']],
    );
    expect(kept.rows[0]).toEqual({ deleted: true });
  });
});
