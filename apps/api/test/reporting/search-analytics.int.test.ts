import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildDataDictionary } from '../../src/db/data-dictionary/build';
import { call, newIp, type Harness, type LoggedInAccount, startHarness } from '../identity/harness';
import { fundingSteps } from '../credit/funding-steps';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * Task 7-6 (doc 17 §6, §7; docs/decisions/task-7-6-decisions.md): the public search's log
 * (never the term), its two reports and the index suggestions (EXPLAIN, never an index made);
 * the anonymized `analytics` views (test 10: no identifying column, no raw id, stable
 * pseudonyms, the key unreadable); the data dictionary covering every table and column.
 */

type World = Awaited<ReturnType<typeof creditWorld>>;

let h: Harness;
let w: World;
let admin: LoggedInAccount;
let support: LoggedInAccount;
let report: Pool;

const DICTIONARY = join(__dirname, '../../../../docs/data-dictionary.md');

async function setConfig(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2::jsonb, now(), 'approved', 'آزمون', now())`,
    [key, JSON.stringify(value)],
  );
}

const search = (query: Record<string, string>) =>
  call(h, 'GET', `/search/doctors?${new URLSearchParams(query).toString()}`, { ip: newIp() });
const run = (who: LoggedInAccount, code: string, params: Body = {}) =>
  w.staff(who, 'POST', `/reporting/reports/${code}/run`, { params });
const rowsOf = (r: { body: Body }) => r.body['rows'] as Body[];

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  admin = await w.role('system_admin');
  support = await w.role('support');
  report = new Pool({ connectionString: h.db.reportUrl, max: 2 });
  // A case and an approved application, and a ticket: rows for the analytics views.
  const steps = fundingSteps(h, w, {
    manager: await w.role('credit_manager'),
    finance: await w.role('accounting'),
  });
  const { patient } = await steps.approved();
  await setConfig('ticket.topics', [
    { code: 'general', title: 'عمومی', unit: 'support', responseHours: 0, active: true },
  ]);
  const made = await w.as(patient, 'POST', '/me/tickets', {
    topicCode: 'general',
    subject: 'پرسش',
    body: 'سلام، پرسشی دارم.',
    links: [],
  });
  expect(made.status).toBe(201);
}, 600_000);

afterAll(async () => {
  await report.end();
  await h.close();
});

describe('the search log (doc 17 §6)', () => {
  it('keeps one row per public search: the filters and the time, never the term', async () => {
    await setConfig('catalog.search_enabled', true);
    const before = await h.owner.query<Row>('SELECT count(*)::int AS n FROM search_query_log');
    expect(
      (await search({ q: 'علی ۰۹۱۲۱۲۳۴۵۶۷', cityCode: 'tehran', credit: 'true' })).status,
    ).toBe(200);
    expect((await search({ cityCode: 'tehran' })).status).toBe(200);
    expect((await search({})).status).toBe(200);
    const { rows } = await h.owner.query<Row>(
      `SELECT * FROM search_query_log ORDER BY created_at DESC, id DESC LIMIT 3`,
    );
    expect(Number(before.rows[0]?.['n']) + 3).toBe(
      Number(
        (await h.owner.query<Row>('SELECT count(*)::int AS n FROM search_query_log')).rows[0]?.[
          'n'
        ],
      ),
    );
    const [none, city, both] = rows;
    expect(both).toMatchObject({
      audience: 'public',
      order_by: 'relevance',
      filters: ['cityCode', 'credit'],
      filter_combo: 'cityCode+credit',
      has_term: true,
    });
    expect(city).toMatchObject({
      filters: ['cityCode'],
      filter_combo: 'cityCode',
      has_term: false,
    });
    expect(none).toMatchObject({ filters: [], filter_combo: 'none', has_term: false });
    // Rule 30: no column holds the term.
    expect(JSON.stringify(rows)).not.toContain('علی');
    expect(JSON.stringify(rows)).not.toContain('912');
  });

  it('is append only', async () => {
    await expect(h.owner.query('UPDATE search_query_log SET total = 0')).rejects.toThrow();
    await expect(h.owner.query('DELETE FROM search_query_log')).rejects.toThrow();
  });

  it('reports each filter and each combination with its count and p95, the admin only', async () => {
    await h.owner.query(`
      INSERT INTO search_query_log (audience, order_by, filters, filter_combo, has_term, page,
        page_size, total, returned, duration_ms)
      SELECT 'public', 'soonest', ARRAY['fieldCode']::text[], 'fieldCode', false, 1, 20, 0, 0, d
      FROM generate_series(1, 100) AS d`);
    const filters = await run(admin, 'search_filters', { range: { relative: 'today' } });
    expect(filters.status).toBe(200);
    const field = rowsOf(filters).find((r) => r['filter'] === 'fieldCode');
    // p95 of 1..100 (continuous) is 95.05, rounded.
    expect(field).toMatchObject({ searches: 100, avgMs: 51, p95Ms: 95 });
    expect(
      rowsOf(filters).find((r) => r['filter'] === 'cityCode')?.['searches'],
    ).toBeGreaterThanOrEqual(2);
    expect(
      rowsOf(filters).find((r) => r['filter'] === 'none')?.['searches'],
    ).toBeGreaterThanOrEqual(1);

    const combos = await run(admin, 'search_combinations', { range: { relative: 'today' } });
    expect(combos.status).toBe(200);
    expect(rowsOf(combos)[0]).toMatchObject({ combination: 'fieldCode', searches: 100, p95Ms: 95 });
    expect(rowsOf(combos).find((r) => r['combination'] === 'cityCode+credit')).toMatchObject({
      searches: 1,
      withTerm: 1,
    });

    expect((await run(support, 'search_filters')).status).toBe(404);
    const listed = await w.staff(support, 'GET', '/reporting/reports');
    expect(JSON.stringify(listed.body)).not.toContain('search_filters');
  });

  it('suggests indexes as Markdown with sample plans, and never makes one', async () => {
    const indexes = async () =>
      (
        await h.owner.query<Row>(
          "SELECT count(*)::int AS n FROM pg_indexes WHERE tablename IN ('search_entries', 'search_query_log')",
        )
      ).rows[0]?.['n'];
    const before = await indexes();
    const res = await w.staff(admin, 'GET', '/reporting/search-insights');
    expect(res.status).toBe(200);
    const md = res.body['markdown'] as string;
    expect(md).toContain('# پیشنهاد ایندکس جست‌وجو');
    expect(md).toContain('`fieldCode`');
    expect(md).toContain('search_entries_treatment_field_codes_idx');
    // The sample plans are real EXPLAIN output on the reporting connection.
    expect(md).toMatch(/Scan on search_entries|Scan using search_entries/);
    // credit_enabled has no index of its own: the one suggestion, a statement to review.
    expect(md).toContain('CREATE INDEX CONCURRENTLY search_entries_credit_idx');
    expect(md).not.toContain('search_entries_city_idx ON');
    expect(await indexes()).toBe(before);

    expect((await w.staff(support, 'GET', '/reporting/search-insights')).status).toBe(403);
  });
});

describe('doc 17 §9 test 10: the analytics views', () => {
  const VIEWS = ['cases', 'credit_applications', 'installments', 'tickets'];
  const IDENTIFYING =
    /(^|_)(name|mobile|national|sheba|iban|address|phone|email|ip|username|subject|body|note|notes)(_|$)|^id$|_id$|_ids$/;

  it('have no identifying column: no name, mobile, national id, free text or raw id', async () => {
    const { rows } = await report.query<Row>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'analytics' ORDER BY table_name, ordinal_position`,
    );
    const byView = new Map<string, string[]>();
    for (const r of rows) {
      const list = byView.get(r['table_name'] as string) ?? [];
      list.push(r['column_name'] as string);
      byView.set(r['table_name'] as string, list);
    }
    expect([...byView.keys()].sort()).toEqual(VIEWS);
    for (const [view, columns] of byView) {
      for (const c of columns)
        expect({ view, column: c, identifying: IDENTIFYING.test(c) }).toMatchObject({
          identifying: false,
        });
    }
  });

  it('give stable pseudonyms that are never a raw id', async () => {
    const raw = new Set<string>();
    for (const table of ['cases', 'persons', 'credit_applications', 'tickets', 'user_accounts']) {
      for (const r of (await h.owner.query<Row>(`SELECT id::text AS id FROM ${table}`)).rows) {
        raw.add(r['id'] as string);
      }
    }
    for (const view of VIEWS) {
      const first = (await report.query<Row>(`SELECT * FROM analytics.${view}`)).rows;
      const again = (await report.query<Row>(`SELECT * FROM analytics.${view}`)).rows;
      if (view !== 'installments') expect(first.length).toBeGreaterThan(0);
      expect(again).toEqual(first);
      for (const row of first) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string') expect(raw.has(value)).toBe(false);
        }
      }
    }
    const t = (await report.query<Row>('SELECT ticket_pid FROM analytics.tickets')).rows[0];
    expect(t?.['ticket_pid']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keep the key from the reporting role and the views from the app role', async () => {
    await expect(report.query('SELECT key FROM analytics.pseudonym_key')).rejects.toMatchObject({
      code: '42501',
    });
    const app = new Pool({ connectionString: h.db.appUrl, max: 1 });
    try {
      await expect(app.query('SELECT * FROM analytics.cases')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await app.end();
    }
  });
});

describe('the data dictionary (doc 17 §7)', () => {
  it('describes every table and every column in Persian, and the committed file is current', async () => {
    const d = await buildDataDictionary(h.owner);
    expect(d.missingTables).toEqual([]);
    expect(d.staleTables).toEqual([]);
    expect(d.missingTokens).toEqual([]);
    if (process.env['UPDATE_DICTIONARY'] === '1') writeFileSync(DICTIONARY, d.markdown);
    expect(readFileSync(DICTIONARY, 'utf8')).toBe(d.markdown);
  });

  // Owner 1405/07/22: a migration once added columns without the regenerated file. This one
  // never writes: the committed file is the generated one, line for line, or it is red.
  it('the committed docs/data-dictionary.md is exactly what the schema generates now', async () => {
    const generated = (await buildDataDictionary(h.owner)).markdown.split('\n');
    const committed = readFileSync(DICTIONARY, 'utf8').split('\n');
    const first = generated.findIndex((line, i) => line !== committed[i]);
    expect(
      { lines: committed.length, firstDifferentLine: first === -1 ? null : first + 1 },
      'regenerate it with UPDATE_DICTIONARY=1 on the test above and commit it with the schema',
    ).toEqual({ lines: generated.length, firstDifferentLine: null });
  });
});
