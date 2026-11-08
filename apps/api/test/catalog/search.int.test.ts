import { randomInt, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  fromJalali,
  gregorianDayOf,
  nextJalaliDay,
  toJalali,
  weekdayOf,
  type EventEnvelope,
  type JalaliDate,
  type SearchResponse,
  type SearchResult,
  type Weekday,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { BOOKABLE_SLOTS, type BookableSlots } from '../../src/common/booking/bookable-slots.port';
import { TARIFF_BOOK, type TariffBook } from '../../src/common/catalog/tariff-book.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../src/common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../src/common/config/config.port';
import { DATABASE, type Database } from '../../src/db/database.module';
import { SearchIndex, SearchIndexConsumer } from '../../src/modules/catalog/search-index';
import { SearchService } from '../../src/modules/catalog/search.service';
import { councilNumber, nationalId, sheba } from './fixtures';
import {
  call,
  grantRole,
  loggedInAccount,
  newIp,
  newMobile,
  otpLogin,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';

import { addHolidayByBatch } from '../config/holiday-batch';

/**
 * Task 2-7 (doc 08 §9, ADR-028): the public search. Acceptance: doc 08 §15 test 12, and
 * EXPLAIN shows the main query using its index. Also the owner's decisions of task 2-7:
 * the index follows the events (a suspended center leaves the results), the rebuild, the
 * credit flag, the featured section apart, live slots over a hint, nothing of another
 * workplace leaking, and the p95 of a results page larger than the pilot.
 */

let h: Harness;
let db: Database;
let index: SearchIndex;
let consumer: SearchIndexConsumer;
let specialist: LoggedInAccount;
let networkManager: LoggedInAccount;
let approver: LoggedInAccount;
let admin: LoggedInAccount;
let admin2: LoggedInAccount;

type Row = Record<string, unknown>;
const reason = { reason: 'آزمون جست‌وجو' };

const staff = (who: LoggedInAccount, method: string, path: string, body?: unknown) =>
  call(h, method, path, { bearer: who.access, ...(body === undefined ? {} : { body }) });

const LETTERS = 'ابپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';
/** A word of Persian letters met nowhere else in this run: names results of one test. */
const tag = () => Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join('');

function dayAhead(days: number): JalaliDate {
  let date = toJalali(new Date());
  for (let i = 0; i < days; i++) date = nextJalaliDay(date);
  return date;
}
const at = (day: JalaliDate, hour: number, minute = 0) => fromJalali(day, { hour, minute });

interface Center {
  centerId: string;
  branchId: string;
  manager: LoggedInAccount;
}

/** An active center in Tehran with its manager. */
async function center(name: string): Promise<Center> {
  const created = await staff(specialist, 'POST', '/catalog/centers', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    personType: 'natural',
    identifier: nationalId(),
    name,
    cityCode: 'tehran',
    sheba: sheba(),
    accountHolderName: 'صاحب حساب',
    treatmentFieldCodes: ['dental'],
  });
  expect(created.status).toBe(201);
  const centerId = created.body['id'] as string;
  const setAll = async (status: string) => {
    const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
    for (const doc of detail.body['documents'] as { code: string }[]) {
      await staff(specialist, 'PUT', `/catalog/centers/${centerId}/documents/${doc.code}`, {
        status,
      });
    }
  };
  await setAll('received');
  await staff(specialist, 'POST', `/catalog/centers/${centerId}/submit`, reason);
  await setAll('verified');
  const proposed = await staff(
    specialist,
    'POST',
    `/catalog/centers/${centerId}/activation-requests`,
    reason,
  );
  const approved = await staff(
    approver,
    'POST',
    `/catalog/requests/${proposed.body['id'] as string}/approve`,
    {},
  );
  expect(approved.status).toBe(200);
  const detail = await staff(specialist, 'GET', `/catalog/centers/${centerId}`);
  const [branch] = detail.body['branches'] as { id: string }[];
  const manager = await loggedInAccount(h, 'center');
  await grantRole(h, manager.id, 'center_manager', {
    kind: 'center',
    nodeId: created.body['nodeId'] as string,
  });
  return { centerId, branchId: branch?.id ?? '', manager };
}

interface Doctor {
  doctorId: string;
  workplaceId: string;
}

/** A doctor at the center's branch, with a visit price. */
async function doctor(c: Center, name: string, minRial = '5000000', maxRial = '8000000') {
  const created = await staff(specialist, 'POST', '/catalog/doctors', {
    // Owner 1405/07/27: the registration form requires the contract term.
    contractTerm: { startsOn: '2026-10-01', months: 12 },
    name,
    medicalCouncilNumber: councilNumber(),
    treatmentFieldCodes: ['dental'],
    workplace: { kind: 'branch', branchId: c.branchId },
    ...reason,
  });
  expect(created.status).toBe(201);
  const doctorId = created.body['id'] as string;
  const detail = await staff(specialist, 'GET', `/catalog/doctors/${doctorId}`);
  const [place] = detail.body['workplaces'] as { id: string }[];
  const workplaceId = place?.id ?? '';
  expect((await setPrice(c.manager, workplaceId, 'visit', minRial, maxRial)).status).toBe(201);
  return { doctorId, workplaceId } satisfies Doctor;
}

const setPrice = (
  who: LoggedInAccount,
  workplaceId: string,
  serviceCode: string,
  minRial: string,
  maxRial: string,
) =>
  staff(who, 'POST', '/catalog/tariffs', {
    owner: { kind: 'workplace', workplaceId },
    serviceCode,
    pricing: { kind: 'range', minRial, maxRial },
    ...reason,
  });

/** Extra hours on one day (open even on a holiday). */
async function openDay(
  who: LoggedInAccount,
  workplaceId: string,
  day: JalaliDate,
  start = '09:00',
  end = '12:00',
  serviceCodes = ['visit'],
) {
  const res = await staff(who, 'POST', `/booking/workplaces/${workplaceId}/exceptions`, {
    kind: 'extra',
    on: day,
    start,
    end,
    slotMinutes: 30,
    serviceCodes,
    ...reason,
  });
  expect(res.status).toBe(201);
}

// --- the index, as the worker runs it -------------------------------------------------------

const delivered = new Set<string>();

/** Hands every new outbox event to the search consumer, each in its own transaction. */
async function deliver(): Promise<number> {
  const { rows } = await h.owner.query<Row>(
    `SELECT id, event_type, aggregate_type, aggregate_id, payload, created_at
     FROM outbox_events ORDER BY created_at, id`,
  );
  let handled = 0;
  for (const row of rows) {
    const id = String(row['id']);
    if (delivered.has(id)) continue;
    delivered.add(id);
    const type = String(row['event_type']);
    if (!consumer.eventTypes.includes(type)) continue;
    const envelope: EventEnvelope = {
      id,
      type,
      aggregateType: String(row['aggregate_type']),
      aggregateId: String(row['aggregate_id']),
      payload: row['payload'],
      occurredAt: new Date(row['created_at'] as string).toISOString(),
    };
    await db.transaction((tx) => consumer.handle(envelope, tx));
    handled++;
  }
  return handled;
}

/** The events, then the refresher: what the worker does within seconds. */
async function settle() {
  await deliver();
  await index.refreshDue(new Date());
}

async function search(query: Record<string, string>, ip = newIp()) {
  return call(h, 'GET', `/search/doctors?${new URLSearchParams(query).toString()}`, { ip });
}

async function found(query: Record<string, string>): Promise<SearchResponse> {
  const res = await search(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as unknown as SearchResponse;
}

const ids = (r: SearchResponse) => r.results.map((x) => x.workplaceId);

async function entryOf(workplaceId: string) {
  const { rows } = await h.owner.query<Row>(
    'SELECT * FROM search_entries WHERE workplace_id = $1',
    [workplaceId],
  );
  return rows[0];
}

async function setConfig(key: string, value: unknown) {
  await h.owner.query(
    `INSERT INTO config_values (key, scope_level, value, effective_at, status, reason, decided_at)
     VALUES ($1, 'global', $2::jsonb, now(), 'approved', 'آزمون', now())`,
    [key, JSON.stringify(value)],
  );
}

async function patient() {
  const mobile = newMobile();
  const login = await otpLogin(h, mobile, 'mobile', { ip: newIp() });
  expect(login.status).toBe(200);
  return login.body['accessToken'] as string;
}

beforeAll(async () => {
  h = await startHarness();
  db = h.app.get<Database>(DATABASE);
  index = h.app.get(SearchIndex);
  consumer = new SearchIndexConsumer({ register: () => undefined }, index);
  [specialist, networkManager, approver, admin] = await Promise.all([
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
    loggedInAccount(h, 'staff'),
  ]);
  await grantRole(h, specialist.id, 'network_specialist', { kind: 'city', code: 'tehran' });
  await grantRole(h, networkManager.id, 'network_manager');
  await grantRole(h, approver.id, 'network_manager');
  await grantRole(h, admin.id, 'ceo');
  admin2 = await loggedInAccount(h, 'staff');
  await grantRole(h, admin2.id, 'ceo');
  expect(
    (
      await staff(networkManager, 'POST', '/catalog/fields', {
        code: 'dental',
        name: 'دندانپزشکی',
        ...reason,
      })
    ).status,
  ).toBe(201);
});

afterAll(async () => {
  await h.close();
});

describe('the feature flag (CLAUDE.md §4)', () => {
  it('is off after the migration: the public search answers feature_disabled', async () => {
    const res = await search({ q: 'علی' });
    expect(res).toMatchObject({ status: 403, body: { error: 'feature_disabled' } });
    await setConfig('catalog.search_enabled', true);
    expect((await search({ q: 'علی' })).status).toBe(200);
  });
});

describe('doc 08 §15 test 12: «علي» and «علی», «۱۴۰۵» and «1405» give the same results', () => {
  it('for free text, the doctor’s name and the center’s name', async () => {
    const t = tag();
    // Typed with the Arabic ي and ك and Persian digits; stored normalized (rule 23).
    const c = await center(`كلينيك ۱۴۰۵ ${t}`);
    const d = await doctor(c, `دكتر علي ${t}`);
    await openDay(c.manager, d.workplaceId, dayAhead(4));
    await settle();

    const entry = await entryOf(d.workplaceId);
    expect(entry?.['search_key']).toContain('علی');
    expect(entry?.['search_key']).toContain('1405');
    expect(entry?.['place_name']).toBe(`کلینیک 1405 ${t}`);

    const pairs: [Record<string, string>, Record<string, string>][] = [
      [{ q: `علي ${t}` }, { q: `علی ${t}` }],
      [{ q: `۱۴۰۵ ${t}` }, { q: `1405 ${t}` }],
      [{ q: `١٤٠٥ ${t}` }, { q: `1405 ${t}` }],
      [
        { doctorName: 'علي', centerName: t },
        { doctorName: 'علی', centerName: t },
      ],
      [{ centerName: `كلينيك ۱۴۰۵ ${t}` }, { centerName: `کلینیک 1405 ${t}` }],
    ];
    for (const [a, b] of pairs) {
      const [ra, rb] = await Promise.all([found(a), found(b)]);
      expect(ids(ra)).toEqual(ids(rb));
      expect(ids(ra)).toContain(d.workplaceId);
    }
    // The public profile's name reaches the public (not stripped as a patient's doctor).
    const shown = (await found({ centerName: t })).results[0];
    expect(shown?.doctor).toEqual({ id: d.doctorId, name: `دکتر علی ${t}` });
    // And the broad terms alone, whatever else the database holds.
    for (const [a, b] of [
      [{ q: 'علي' }, { q: 'علی' }],
      [{ q: '۱۴۰۵' }, { q: '1405' }],
    ] as const) {
      const [ra, rb] = await Promise.all([
        found({ ...a, pageSize: '20' }),
        found({ ...b, pageSize: '20' }),
      ]);
      expect(ids(ra)).toEqual(ids(rb));
      expect(ra.total).toBe(rb.total);
      expect(ids(ra)).toContain(d.workplaceId);
    }
  });
});

describe('what is found (doc 08 §9)', () => {
  it('only a workplace with a free time; it appears once its calendar opens', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const d = await doctor(c, `دکتر ${t}`);
    await settle();
    expect(ids(await found({ centerName: t }))).toEqual([]);
    expect((await entryOf(d.workplaceId))?.['listed']).toBe(true);
    await openDay(c.manager, d.workplaceId, dayAhead(3));
    await settle();
    expect(ids(await found({ centerName: t }))).toEqual([d.workplaceId]);
  });

  it('a suspended center leaves the results as its event is processed, before any refresh', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const d = await doctor(c, `دکتر ${t}`);
    await openDay(c.manager, d.workplaceId, dayAhead(3));
    await settle();
    expect(ids(await found({ centerName: t }))).toEqual([d.workplaceId]);

    const suspended = await staff(
      specialist,
      'POST',
      `/catalog/centers/${c.centerId}/suspend`,
      reason,
    );
    expect(suspended.status).toBe(200);
    // Only the event: the refresher has not run.
    expect(await deliver()).toBeGreaterThan(0);
    expect(ids(await found({ centerName: t }))).toEqual([]);
    const entry = await entryOf(d.workplaceId);
    expect(entry).toMatchObject({ listed: false, next_free_slot_at: null });
    // Nothing physical is deleted (rule 7).
    expect(entry).toBeDefined();
  });

  it('filters by city, field, service, price, earliest free day and credit', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const early = await doctor(c, `دکتر زود ${t}`, '5000000', '8000000');
    const late = await doctor(c, `دکتر دیر ${t}`, '10000000', '12000000');
    await openDay(c.manager, early.workplaceId, dayAhead(3));
    await openDay(c.manager, late.workplaceId, dayAhead(12));
    // A second service, priced at the late doctor's only.
    const code = `svc_${String(randomInt(100_000, 999_999))}`;
    expect(
      (
        await staff(networkManager, 'POST', '/catalog/services', {
          fieldCode: 'dental',
          code,
          name: `جرم‌گیری ${t}`,
          ...reason,
        })
      ).status,
    ).toBe(201);
    expect((await setPrice(c.manager, late.workplaceId, code, '2000000', '3000000')).status).toBe(
      201,
    );
    await settle();

    const base = { centerName: t };
    expect(ids(await found({ ...base, cityCode: 'tehran' })).sort()).toEqual(
      [early.workplaceId, late.workplaceId].sort(),
    );
    expect(ids(await found({ ...base, cityCode: 'shiraz' }))).toEqual([]);
    expect(ids(await found({ ...base, fieldCode: 'dental' }))).toHaveLength(2);
    expect(ids(await found({ ...base, fieldCode: 'ortho' }))).toEqual([]);
    expect(ids(await found({ ...base, serviceCode: code }))).toEqual([late.workplaceId]);
    // The service name is part of the free text.
    expect(ids(await found({ q: `جرم گیری ${t}` }))).toEqual([late.workplaceId]);

    // The visit's price unless a service is named; ranges that overlap match.
    expect(ids(await found({ ...base, minPriceRial: '9000000' }))).toEqual([late.workplaceId]);
    expect(ids(await found({ ...base, maxPriceRial: '۴۰۰۰۰۰۰' }))).toEqual([]);
    expect(ids(await found({ ...base, minPriceRial: '6000000', maxPriceRial: '7000000' }))).toEqual(
      [early.workplaceId],
    );
    const priced = await found({ ...base, serviceCode: code, maxPriceRial: '2500000' });
    expect(ids(priced)).toEqual([late.workplaceId]);
    // No published profile yet: nothing to link to (task 2-11).
    expect(priced.results[0]?.profileSlug).toBeNull();

    // The booking page reads the same workplace with every priced service (task 2-11).
    const one = await call(h, 'GET', `/public/workplaces/${late.workplaceId}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      workplaceId: late.workplaceId,
      profileSlug: null,
      placeName: expect.stringContaining(t) as unknown,
    });
    expect(
      (one.body['services'] as { serviceCode: string; serviceName: string; minRial: string }[])
        .map((x) => [x.serviceCode, x.serviceName, x.minRial])
        .sort(),
    ).toEqual(
      [
        [code, `جرم‌گیری ${t}`, '2000000'],
        ['visit', 'ویزیت', '10000000'],
      ].sort(),
    );
    expect((await call(h, 'GET', `/public/workplaces/${randomUUID()}`)).status).toBe(404);
    expect(priced.results[0]?.price).toEqual({
      serviceCode: code,
      // The name, for the page (task 2-11).
      serviceName: `جرم‌گیری ${t}`,
      isFree: false,
      minRial: '2000000',
      maxRial: '3000000',
    });

    expect(ids(await found({ ...base, freeBy: gregorianDayOf(dayAhead(5)) }))).toEqual([
      early.workplaceId,
    ]);
    expect(ids(await found({ ...base, freeBy: gregorianDayOf(dayAhead(12)) }))).toHaveLength(2);

    // Credit: off by default; the network specialist turns it on, audited.
    expect(ids(await found({ ...base, credit: 'true' }))).toEqual([]);
    const refused = await staff(
      c.manager,
      'PUT',
      `/catalog/workplaces/${late.workplaceId}/credit`,
      {
        enabled: true,
        ...reason,
      },
    );
    expect(refused.status).toBe(403);
    const set = await staff(specialist, 'PUT', `/catalog/workplaces/${late.workplaceId}/credit`, {
      enabled: true,
      ...reason,
    });
    expect(set.status).toBe(200);
    expect(set.body['creditEnabled']).toBe(true);
    const { rows: audit } = await h.owner.query<Row>(
      `SELECT actor_account_id, before, after FROM audit_events
       WHERE action = 'catalog.workplace_credit_changed' AND entity_id = $1`,
      [late.workplaceId],
    );
    expect(audit).toEqual([
      {
        actor_account_id: specialist.id,
        before: { creditEnabled: false },
        after: { creditEnabled: true },
      },
    ]);
    await deliver();
    const credit = await found({ ...base, credit: 'true' });
    expect(ids(credit)).toEqual([late.workplaceId]);
    expect(credit.results[0]?.creditEnabled).toBe(true);
  });
});

describe('the order (doc 08 §9, «رتبه‌بندی شفاف») and the featured section', () => {
  it('soonest without text; best match with it; featured apart, labelled and empty', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const soon = await doctor(c, `دکتر پارسا ${t}`);
    const later = await doctor(c, `دکتر ${t} سهراب`);
    await openDay(c.manager, soon.workplaceId, dayAhead(3));
    await openDay(c.manager, later.workplaceId, dayAhead(6));
    await settle();

    const plain = await found({ centerName: t });
    expect(plain.order).toBe('soonest');
    expect(ids(plain)).toEqual([soon.workplaceId, later.workplaceId]);
    expect(plain.featured).toBeNull();

    const matched = await found({ q: `سهراب ${t}` });
    expect(matched.order).toBe('relevance');
    expect(ids(matched)[0]).toBe(later.workplaceId);

    await setConfig('catalog.search_featured_enabled', true);
    const withFeatured = await found({ centerName: t });
    expect(withFeatured.featured).toEqual({ label: 'پیشنهاد سپهر', results: [] });
    // The results are the same list in the same order: the section never mixes in.
    expect(ids(withFeatured)).toEqual(ids(plain));
    await setConfig('catalog.search_featured_enabled', false);
  });

  it('pages without repeating or skipping', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const all: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = await doctor(c, `دکتر ${t} ${String(i)}`);
      await openDay(c.manager, d.workplaceId, dayAhead(3 + i));
      all.push(d.workplaceId);
    }
    await settle();
    const pages = await Promise.all(
      ['1', '2', '3'].map((page) => found({ centerName: t, pageSize: '2', page })),
    );
    expect(pages.flatMap(ids)).toEqual(all);
    expect(pages[0]?.total).toBe(5);
  });
});

describe('free times: a hint in the index, live slots on the page (task 2-7 decision 4)', () => {
  it('shows the slots booking would, even before the hint catches up with a hold', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const d = await doctor(c, `دکتر ${t}`);
    const day = dayAhead(4);
    await openDay(c.manager, d.workplaceId, day);
    await settle();

    const first = (await found({ centerName: t })).results[0] as SearchResult;
    expect(first.nextFreeSlotHintAt).toBe(at(day, 9).toISOString());
    expect(first.slots.map((s) => s.startsAt)).toEqual([
      at(day, 9).toISOString(),
      at(day, 9, 30).toISOString(),
      at(day, 10).toISOString(),
    ]);

    const token = await patient();
    const held = await call(h, 'POST', '/booking/appointments/hold', {
      bearer: token,
      body: {
        workplaceId: d.workplaceId,
        serviceCode: 'visit',
        startsAt: at(day, 9).toISOString(),
      },
    });
    expect(held.status).toBe(201);

    // The hint is stale until the refresher runs; the slots are not.
    const stale = (await found({ centerName: t })).results[0] as SearchResult;
    expect(stale.nextFreeSlotHintAt).toBe(at(day, 9).toISOString());
    expect(stale.slots[0]?.startsAt).toBe(at(day, 9, 30).toISOString());
    const booking = await call(
      h,
      'GET',
      `/booking/workplaces/${d.workplaceId}/free-slots?from=${gregorianDayOf(day)}&to=${gregorianDayOf(day)}`,
      { bearer: token },
    );
    expect(stale.slots).toEqual((booking.body as unknown as unknown[]).slice(0, 3));

    // A stale hint changes no booking: the time is taken whatever the index says.
    const again = await call(h, 'POST', '/booking/appointments/hold', {
      bearer: await patient(),
      body: {
        workplaceId: d.workplaceId,
        serviceCode: 'visit',
        startsAt: at(day, 9).toISOString(),
      },
    });
    expect(again.status).toBe(409);

    await settle();
    const fresh = (await found({ centerName: t })).results[0] as SearchResult;
    expect(fresh.nextFreeSlotHintAt).toBe(at(day, 9, 30).toISOString());
  });

  it('never tells of the doctor’s other workplace: no busy reason, no other center', async () => {
    const t = tag();
    const a = await center(`کلینیک الف ${t}`);
    const b = await center(`کلینیک ب ${t}`);
    const d = await doctor(a, `دکتر دوجا ${t}`);
    const added = await staff(specialist, 'POST', `/catalog/doctors/${d.doctorId}/workplaces`, {
      workplace: { kind: 'branch', branchId: b.branchId },
      ...reason,
    });
    expect(added.status).toBe(201);
    const atB = added.body['id'] as string;
    expect((await setPrice(b.manager, atB, 'visit', '5000000', '8000000')).status).toBe(201);
    const day = dayAhead(5);
    await openDay(a.manager, d.workplaceId, day, '09:00', '11:00');
    await openDay(b.manager, atB, day, '14:00', '16:00');
    const token = await patient();
    expect(
      (
        await call(h, 'POST', '/booking/appointments/hold', {
          bearer: token,
          body: { workplaceId: atB, serviceCode: 'visit', startsAt: at(day, 14).toISOString() },
        })
      ).status,
    ).toBe(201);
    await settle();

    const res = await search({ centerName: `الف ${t}` });
    expect(res.status).toBe(200);
    const body = res.body as unknown as SearchResponse;
    expect(ids(body)).toEqual([d.workplaceId]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(`کلینیک ب ${t}`);
    expect(text).not.toContain(atB);
    expect(text).not.toContain('busy');
    for (const slot of body.results[0]?.slots ?? []) {
      expect(new Date(slot.startsAt).getTime()).toBeLessThan(at(day, 11).getTime());
    }
    // B's own entry shows B's free time, after the held 14:00.
    const atBResult = (await found({ centerName: `ب ${t}` })).results[0];
    expect(atBResult?.placeName).toBe(`کلینیک ب ${t}`);
    expect(atBResult?.nextFreeSlotHintAt).toBe(at(day, 14, 30).toISOString());
  });

  it('a city holiday on the first free day moves the hint once its event is processed', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const d = await doctor(c, `دکتر ${t}`);
    // Hours on the weekday of three days ahead (four, past a Friday): its first occurrence is
    // that day whatever today is. A fixed Sunday failed on Fridays and Saturdays, when the
    // nearest Sunday is closer than three days and already free.
    let first = dayAhead(3);
    if (weekdayOf(first) === 'friday') first = nextJalaliDay(first);
    const weekday = weekdayOf(first);
    const res = await staff(c.manager, 'PUT', `/booking/workplaces/${d.workplaceId}/schedule`, {
      ranges: [
        {
          weekday,
          start: '09:00',
          end: '10:00',
          slotMinutes: 30,
          serviceCodes: ['visit'],
        },
      ],
      ...reason,
    });
    expect(res.status).toBe(200);
    await settle();
    expect((await found({ centerName: t })).results[0]?.nextFreeSlotHintAt).toBe(
      at(first, 9).toISOString(),
    );

    // Owner 1405/07/27: a city's holiday, saved by a one-day batch of two holders.
    const holiday = await addHolidayByBatch(h, admin, admin2, {
      on: first,
      title: 'تعطیلی آزمون جست‌وجو',
      cityCode: 'tehran',
    });
    expect(holiday.status).toBe(201);
    await deliver();
    // Marked due by the event; the refresher computes it.
    const due = await entryOf(d.workplaceId);
    expect(Number(due?.['pending_changes'])).toBeGreaterThan(0);
    await index.refreshDue(new Date());
    let week = first;
    for (let i = 0; i < 7; i++) week = nextJalaliDay(week);
    expect((await found({ centerName: t })).results[0]?.nextFreeSlotHintAt).toBe(
      at(week, 9).toISOString(),
    );
    // Cleaned up for the tests after: no path removes a holiday now (owner 1405/07/27), so the
    // fixture is soft-deleted directly.
    await h.owner.query('UPDATE holidays SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [
      holiday.body['id'],
      admin.id,
    ]);
    await settle();
  });
});

describe('the index follows every change (task 2-7 decision 1)', () => {
  it('each change the search shows announces itself in the outbox', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const d = await doctor(c, `دکتر ${t}`);
    await openDay(c.manager, d.workplaceId, dayAhead(3));
    await staff(specialist, 'PATCH', `/catalog/centers/${c.centerId}`, {
      name: `کلینیک نو ${t}`,
      ...reason,
    });
    await staff(specialist, 'PATCH', `/catalog/doctors/${d.doctorId}`, {
      name: `دکتر نو ${t}`,
      ...reason,
    });
    await staff(specialist, 'PUT', `/catalog/workplaces/${d.workplaceId}/credit`, {
      enabled: true,
      ...reason,
    });
    const events = async (type: string, aggregateId: string) =>
      (
        await h.owner.query<Row>(
          'SELECT payload FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2',
          [type, aggregateId],
        )
      ).rows.map((r) => r['payload']);
    expect(await events('catalog.doctor_changed', d.doctorId)).toContainEqual({
      doctorId: d.doctorId,
    });
    expect(await events('catalog.center_updated', c.centerId)).toHaveLength(1);
    expect(await events('booking.calendar_changed', d.workplaceId)).toEqual([
      { workplaceId: d.workplaceId, doctorId: d.doctorId },
    ]);
    expect(await events('catalog.workplace_credit_changed', d.workplaceId)).toEqual([
      { workplaceId: d.workplaceId, creditEnabled: true },
    ]);
    const { rows: tariffEvents } = await h.owner.query<Row>(
      `SELECT payload FROM outbox_events WHERE event_type = 'catalog.tariff_changed'
       AND payload->>'workplaceId' = $1`,
      [d.workplaceId],
    );
    expect(tariffEvents).toHaveLength(1);

    await settle();
    const entry = await entryOf(d.workplaceId);
    expect(entry).toMatchObject({
      doctor_name: `دکتر نو ${t}`,
      place_name: `کلینیک نو ${t}`,
      credit_enabled: true,
    });
    expect(ids(await found({ q: `نو ${t}` }))).toEqual([d.workplaceId]);
  });

  it('a price that starts later is shown from its start', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const d = await doctor(c, `دکتر ${t}`);
    await openDay(c.manager, d.workplaceId, dayAhead(3));
    await settle();
    const startsAt = new Date(Date.now() + 3_600_000);
    const res = await staff(c.manager, 'POST', '/catalog/tariffs', {
      owner: { kind: 'workplace', workplaceId: d.workplaceId },
      serviceCode: 'visit',
      pricing: { kind: 'range', minRial: '9000000', maxRial: '9500000' },
      effectiveAt: startsAt.toISOString(),
      ...reason,
    });
    expect(res.status).toBe(201);
    await deliver();
    const entry = await entryOf(d.workplaceId);
    expect(new Date(entry?.['refresh_due_at'] as string).getTime()).toBeLessThanOrEqual(
      startsAt.getTime(),
    );
    expect((await found({ centerName: t })).results[0]?.price?.minRial).toBe('5000000');
  });

  it('a request that arrives while a refresh computes keeps the entry due', async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const d = await doctor(c, `دکتر ${t}`);
    await openDay(c.manager, d.workplaceId, dayAhead(3));
    await settle();
    const slots = h.app.get<BookableSlots>(BOOKABLE_SLOTS);
    let marked = false;
    const racing = new SearchIndex(
      db,
      h.app.get<ConfigPort>(CONFIG),
      h.app.get<WorkplaceDirectory>(WORKPLACE_DIRECTORY),
      h.app.get<TariffBook>(TARIFF_BOOK),
      {
        async upcoming(workplaceId, options) {
          const result = await slots.upcoming(workplaceId, options);
          if (!marked) {
            marked = true;
            // Another event, committed while this refresh is computing.
            await db.transaction((tx) => index.markDue(tx, sql`workplace_id = ${d.workplaceId}`));
          }
          return result;
        },
      },
    );
    await racing.refresh(d.workplaceId);
    const entry = await entryOf(d.workplaceId);
    expect(entry?.['pending_changes']).toBe(1);
    expect(new Date(entry?.['refresh_due_at'] as string).getTime()).toBeLessThanOrEqual(Date.now());
    await index.refresh(d.workplaceId);
    expect((await entryOf(d.workplaceId))?.['pending_changes']).toBe(0);
  });
});

describe('pnpm catalog:rebuild-search (task 2-7 decision 1)', () => {
  it('a dry run writes only its report; an apply fills the index; a second apply changes nothing', async () => {
    await settle();
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const d = await doctor(c, `دکتر ${t}`);
    await openDay(c.manager, d.workplaceId, dayAhead(3));
    // The events are not delivered: the index does not know this workplace yet.
    const { rows: skipped } = await h.owner.query<Row>('SELECT id FROM outbox_events');
    for (const row of skipped) delivered.add(String(row['id']));
    expect(await entryOf(d.workplaceId)).toBeUndefined();
    const count = async () =>
      Number(
        (await h.owner.query<Row>('SELECT count(*)::int AS n FROM search_entries')).rows[0]?.['n'],
      );
    const before = await count();

    const dry = await index.rebuild('dry_run');
    expect(dry.mode).toBe('dry_run');
    expect(dry.inserted).toBe(1);
    expect(await count()).toBe(before);
    expect(await entryOf(d.workplaceId)).toBeUndefined();

    const applied = await index.rebuild('apply');
    expect(applied.inserted).toBe(1);
    expect(applied.workplaces).toBe(dry.workplaces);
    expect(await count()).toBe(before + 1);
    expect(ids(await found({ centerName: t }))).toEqual([d.workplaceId]);

    const again = await index.rebuild('apply');
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: applied.workplaces });

    const { rows: runs } = await h.owner.query<Row>(
      'SELECT id, mode, inserted FROM search_rebuild_runs WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[dry.runId, applied.runId, again.runId]],
    );
    expect(runs.map((r) => [r['mode'], r['inserted']])).toEqual([
      ['dry_run', 1],
      ['apply', 1],
      ['apply', 0],
    ]);
    // The report is append-only.
    await expect(
      h.owner.query('UPDATE search_rebuild_runs SET inserted = 9 WHERE id = $1', [dry.runId]),
    ).rejects.toThrow();
  });
});

describe('the log and the rate limit', () => {
  it('logs the shape of a search, and the phrase without long digit runs (rule 30)', async () => {
    const spy = vi.spyOn(Logger.prototype, 'log');
    try {
      await found({ q: '09121234567 علی', cityCode: 'tehran', credit: 'true' });
      const lines = spy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes('"catalog.search"'));
      expect(lines).toHaveLength(1);
      const logged = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
      expect(logged).toMatchObject({
        event: 'catalog.search',
        audience: 'public',
        order: 'relevance',
        filters: ['cityCode', 'credit'],
        term: '# علی',
      });
      expect(lines[0]).not.toContain('09121234567');
      expect(lines[0]).not.toContain('9121234567');
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a client over its limit per minute', async () => {
    await setConfig('catalog.search_policy', {
      perIpPerMinute: 3,
      slotsPerResult: 3,
      maxEntryAgeMinutes: 60,
    });
    const ip = newIp();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await search({ q: 'علی' }, ip)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect((await search({ q: 'علی' })).status).toBe(200);
    await setConfig('catalog.search_policy', {
      perIpPerMinute: 10_000,
      slotsPerResult: 3,
      maxEntryAgeMinutes: 60,
    });
  });
});

/**
 * The measurements of the scale tests, for the task report: printed, and written to
 * SEARCH_REPORT_DIR when that is set (the integration config silences the console).
 */
function report(name: string, text: string) {
  console.log(`SEARCH_${name.toUpperCase()}\n${text}`);
  const dir = process.env['SEARCH_REPORT_DIR'];
  if (dir) writeFileSync(`${dir}/search-${name}.txt`, `${text}\n`);
}

describe('scale: EXPLAIN and the p95 of a page (doc 09 acceptance; task 2-7 decision 4)', () => {
  const SYNTHETIC = 20_000;
  const REAL = 20;

  beforeAll(async () => {
    await setConfig('catalog.search_enabled', true);
    // Index entries of workplaces that do not exist, so they are never refreshed and show
    // no slots; letters only (no digits), later than every real free time.
    await h.owner.query(
      `INSERT INTO search_entries (workplace_id, doctor_id, city_code, doctor_name, search_key,
         doctor_name_key, treatment_fields, treatment_field_codes, service_codes, credit_enabled,
         listed, next_free_slot_at, refresh_due_at, refreshed_at)
       SELECT uuidv7(), uuidv7(), 'tehran', name, name || ' دندانپزشکی', name,
              '[{"code":"dental","name":"دندانپزشکی"}]', '{dental}', '{visit}', false, true,
              now() + interval '40 days' + g * interval '1 minute', now() + interval '1 day', now()
       FROM (SELECT g, 'دکتر نمونه ' || translate(g::text, '0123456789', 'ابپتثجچحخد') AS name
             FROM generate_series(1, $1::int) g) s`,
      [SYNTHETIC],
    );
    // As autovacuum leaves it: a bulk insert sits in the GIN pending list, which the planner
    // prices in until a vacuum merges it into the trigram index.
    await h.owner.query('VACUUM ANALYZE search_entries');
  });

  it('the main query uses the trigram index', async () => {
    const service = h.app.get(SearchService);
    // One doctor's name among 20,000 that all share «دکتر نمونه»: a selective search.
    const query = { q: 'بپتث', cityCode: 'tehran' };
    const statement = service.statement(query, 'relevance', 1, 10);
    const { sql: text, params } = new PgDialect().sqlToQuery(statement);
    const { rows } = await h.owner.query<Row>(`EXPLAIN ${text}`, params);
    const plan = rows.map((r) => String(r['QUERY PLAN'])).join('\n');
    report('explain', plan);
    expect(plan).toContain('search_entries_search_key_trgm');
    expect(plan).not.toMatch(/Seq Scan on search_entries/);
    // Through the API: the exact word first (entry 1234), then the near ones (11234, 1234x…).
    const res = await found(query);
    expect(res.order).toBe('relevance');
    expect(res.results[0]?.doctor.name).toBe('دکتر نمونه بپتث');
    expect(res.total).toBeGreaterThanOrEqual(12);
  });

  it(`a page of ${String(REAL)} real doctors among ${String(SYNTHETIC)}+ entries: p95 reported`, async () => {
    const t = tag();
    const c = await center(`کلینیک ${t}`);
    const weekdays: Weekday[] = ['saturday', 'sunday', 'monday', 'tuesday', 'wednesday'];
    for (let i = 0; i < REAL; i++) {
      const d = await doctor(c, `دکتر ${t} ${String(i)}`);
      const res = await staff(c.manager, 'PUT', `/booking/workplaces/${d.workplaceId}/schedule`, {
        ranges: weekdays.map((weekday) => ({
          weekday,
          start: '08:00',
          end: '16:00',
          slotMinutes: 20,
          serviceCodes: ['visit'],
        })),
        ...reason,
      });
      expect(res.status).toBe(200);
    }
    await settle();
    const { rows } = await h.owner.query<Row>(
      `SELECT count(*)::int AS n FROM search_entries
       WHERE listed AND next_free_slot_at IS NOT NULL AND city_code = 'tehran'`,
    );
    const listed = Number(rows[0]?.['n']);
    expect(listed).toBeGreaterThanOrEqual(SYNTHETIC + REAL);

    const timings: number[] = [];
    for (let i = 0; i < 60; i++) {
      const started = performance.now();
      const res = await search({ cityCode: 'tehran', pageSize: '20' });
      timings.push(performance.now() - started);
      expect(res.status).toBe(200);
      const body = res.body as unknown as SearchResponse;
      expect(body.results).toHaveLength(20);
      expect(body.results.every((r) => r.slots.length === 3)).toBe(true);
    }
    const sorted = [...timings.slice(10)].sort((a, b) => a - b); // after 10 warm-up requests
    const p = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
    const summary = {
      listedEntries: listed,
      pageSize: 20,
      liveSlotsPerResult: 3,
      requests: sorted.length,
      p50ms: Math.round(p(0.5)),
      p95ms: Math.round(p(0.95)),
      maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
    };
    report('p95', JSON.stringify(summary));
    // A generous bound for a test machine; the number itself is what is reported.
    expect(summary.p95ms).toBeLessThan(2000);
  });
});
