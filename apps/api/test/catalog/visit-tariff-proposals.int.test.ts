import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TARIFF_BOOK, type TariffBook } from '../../src/common/catalog/tariff-book.port';
import { createPool } from '../../src/db/pool';
import {
  grantRole,
  loggedInAccount,
  startHarness,
  type Harness,
  type LoggedInAccount,
} from '../identity/harness';
import { CREDIT_HARNESS, creditWorld, type Body, type Row } from '../credit/world';

/**
 * A doctor's visit price from the internal panel, by two people (owner 1405/07/29, answer i;
 * migration 0100): one holder of catalog.manage_visit_tariffs proposes it for a workplace of
 * their scope, another approves it (the visit's tariff version, the catalog way) or rejects
 * it; never the proposer. With catalog.visit_tariff_internal_only on, the center panel's own
 * path refuses the visit (and only the visit). No ledger row.
 */

let h: Harness;
let w: Awaited<ReturnType<typeof creditWorld>>;
let app: Pool;
let book: TariffBook;
let proposer: LoggedInAccount;
let second: LoggedInAccount;

beforeAll(async () => {
  h = await startHarness(CREDIT_HARNESS);
  w = await creditWorld(h);
  app = createPool(h.db.appUrl, 'test-app');
  book = h.app.get<TariffBook>(TARIFF_BOOK);
  // The network specialist of Tehran proposes; the network manager (global) decides.
  proposer = w.specialist;
  second = await w.role('network_manager');
}, 180_000);

afterAll(async () => {
  await app.end();
  await h.close();
});

const propose = (who: LoggedInAccount, body: Body = {}) =>
  w.staff(who, 'POST', '/catalog/visit-tariff-proposals', {
    workplaceId: w.workplaceId,
    pricing: { kind: 'range', minRial: '7000000', maxRial: '9000000' },
    reason: 'تعرفه ویزیت از فهرست الحاقیه',
    ...body,
  });
const decide = (who: LoggedInAccount, id: string, decision: 'approve' | 'reject') =>
  w.staff(who, 'POST', `/catalog/visit-tariff-proposals/${id}/${decision}`, {
    reason: 'بررسی شد',
  });
const visitNow = () => book.quote(w.workplaceId, 'visit', new Date());

async function ledgerCount() {
  const { rows } = await h.owner.query<Row>('SELECT count(*)::int AS n FROM ledger_entries');
  return rows[0]?.['n'] as number;
}

describe('a visit price from the internal panel, by two people (owner 1405/07/29, answer i)', () => {
  it('is proposed by one, approved by another, and quoted from then on', async () => {
    const before = await visitNow();
    expect(before?.minAmountRial).toBe(5_000_000n);
    const ledger = await ledgerCount();

    const made = await propose(proposer);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      workplaceId: w.workplaceId,
      doctor: { name: 'دکتر اعتبار' },
      placeName: 'کلینیک اعتبار',
      status: 'pending',
      requestedByMe: true,
      minAmountRial: '7000000',
      maxAmountRial: '9000000',
      tariffVersionId: null,
    });
    const id = made.body['id'] as string;
    // Proposing only: the price has not changed.
    expect((await visitNow())?.minAmountRial).toBe(5_000_000n);
    // One open proposal per workplace.
    const again = await propose(second);
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('proposal_open');
    // Never the proposer.
    const self = await decide(proposer, id, 'approve');
    expect(self.status).toBe(403);
    expect(self.body['error']).toBe('second_person_required');

    const approved = await decide(second, id, 'approve');
    expect(approved.status).toBe(201);
    expect(approved.body['status']).toBe('approved');
    expect(approved.body['requestedByMe']).toBe(false);
    const versionId = approved.body['tariffVersionId'] as string;
    const now = await visitNow();
    expect(now).toMatchObject({
      tariffVersionId: versionId,
      source: 'workplace',
      minAmountRial: 7_000_000n,
      maxAmountRial: 9_000_000n,
    });
    // Decided once.
    const twice = await decide(second, id, 'reject');
    expect(twice.status).toBe(409);
    expect(twice.body['error']).toBe('already_decided');

    // Audited on the doctor's behalf, as any price change; no ledger row.
    const { rows } = await h.owner.query<Row>(
      `SELECT action FROM audit_events
       WHERE (entity_id = $1 AND action LIKE 'catalog.visit_tariff_%')
          OR (action = 'catalog.tariff_set' AND after->>'id' = $2)
       ORDER BY seq`,
      [id, versionId],
    );
    expect(rows.map((r) => r['action'])).toEqual([
      'catalog.visit_tariff_proposed',
      'catalog.tariff_set',
      'catalog.visit_tariff_approved',
    ]);
    expect(await ledgerCount()).toBe(ledger);
  });

  it('a rejected proposal changes no price; a free visit and a later start are kept', async () => {
    const before = await visitNow();
    const made = await propose(proposer, {
      pricing: { kind: 'range', minRial: '1000000', maxRial: '1000000' },
    });
    const rejected = await decide(second, made.body['id'] as string, 'reject');
    expect(rejected.status).toBe(201);
    expect(rejected.body).toMatchObject({ status: 'rejected', tariffVersionId: null });
    expect((await visitNow())?.tariffVersionId).toBe(before?.tariffVersionId);

    // Free, from a moment ahead: today's price stands until then.
    const at = new Date(Date.now() + 3 * 86_400_000);
    const free = await propose(proposer, {
      pricing: { kind: 'free' },
      effectiveAt: at.toISOString(),
    });
    expect(free.status).toBe(201);
    expect((await decide(second, free.body['id'] as string, 'approve')).status).toBe(201);
    expect((await visitNow())?.tariffVersionId).toBe(before?.tariffVersionId);
    const later = await book.quote(w.workplaceId, 'visit', new Date(at.getTime() + 1000));
    expect(later).toMatchObject({ isFree: true, minAmountRial: 0n, maxAmountRial: 0n });
  });

  it('reaches only the workplaces of the caller’s scope, and only with the permission', async () => {
    const isfahan = await w.role('network_specialist', { kind: 'city', code: 'isfahan' });
    const hidden = await propose(isfahan);
    expect(hidden.status).toBe(404);
    expect(hidden.body['error']).toBe('workplace_not_found');
    const made = await propose(proposer);
    const id = made.body['id'] as string;
    const listed = await w.staff(isfahan, 'GET', '/catalog/visit-tariff-proposals');
    expect((listed.body as unknown as Body[]).map((p) => p['id'])).not.toContain(id);
    const own = await w.staff(proposer, 'GET', '/catalog/visit-tariff-proposals?status=pending');
    expect((own.body as unknown as Body[]).map((p) => p['id'])).toContain(id);
    const decidedElsewhere = await decide(isfahan, id, 'approve');
    expect(decidedElsewhere.status).toBe(404);
    // A center manager prices in the center panel, not here.
    const manager = await centerManager();
    expect((await propose(manager)).status).toBe(403);
    expect((await decide(second, id, 'reject')).status).toBe(201);
  });

  it('the database holds two people and keeps a decided proposal as it was', async () => {
    const made = await propose(proposer);
    const id = made.body['id'] as string;
    const { rows } = await h.owner.query<Row>(
      'SELECT requested_by FROM visit_tariff_proposals WHERE id = $1',
      [id],
    );
    const by = rows[0]?.['requested_by'] as string;
    await expect(
      h.owner.query(
        `UPDATE visit_tariff_proposals SET status = 'rejected', decided_by = $2, decided_at = now()
         WHERE id = $1`,
        [id, by],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.owner.query('UPDATE visit_tariff_proposals SET min_amount_rial = 1 WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await decide(second, id, 'reject')).status).toBe(201);
    await expect(
      h.owner.query(`UPDATE visit_tariff_proposals SET decision_reason = 'x' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      app.query('DELETE FROM visit_tariff_proposals WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('with the flag on, the center panel no longer sets, withdraws or cancels the visit', async () => {
    const manager = await centerManager();
    const setVisit = () =>
      w.staff(manager, 'POST', '/catalog/tariffs', {
        owner: { kind: 'workplace', workplaceId: w.workplaceId },
        serviceCode: 'visit',
        pricing: { kind: 'range', minRial: '6000000', maxRial: '6000000' },
        effectiveAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        reason: 'تعرفه از پنل مرکز',
      });
    // Off (the default): the one-person path still works.
    const upcoming = await setVisit();
    expect(upcoming.status).toBe(201);
    const tariffId = upcoming.body['id'] as string;
    const versionId = (upcoming.body['upcoming'] as Body[])[0]?.['id'] as string;

    const strategyA = await w.role('strategy_manager');
    const strategyB = await w.role('strategy_manager');
    const flag = await w.staff(strategyA, 'POST', '/config/proposals', {
      key: 'catalog.visit_tariff_internal_only',
      scope: { level: 'global' },
      value: true,
      reason: 'تعرفه ویزیت فقط از پنل داخلی',
    });
    expect(flag.status).toBe(201);
    expect(
      (await w.staff(strategyB, 'POST', `/config/proposals/${flag.body['id'] as string}/approve`))
        .status,
    ).toBe(200);

    const refused = await setVisit();
    expect(refused.status).toBe(403);
    expect(refused.body['error']).toBe('visit_tariff_internal_only');
    const withdraw = await w.staff(manager, 'POST', `/catalog/tariffs/${tariffId}/withdraw`, {
      reason: 'توقف ویزیت',
    });
    expect(withdraw.status).toBe(403);
    expect(withdraw.body['error']).toBe('visit_tariff_internal_only');
    const cancel = await w.staff(manager, 'POST', `/catalog/tariff-versions/${versionId}/cancel`, {
      reason: 'لغو نسخه',
    });
    expect(cancel.status).toBe(403);
    expect(cancel.body['error']).toBe('visit_tariff_internal_only');
    // Another service is untouched.
    const scaling = await w.staff(manager, 'POST', '/catalog/tariffs', {
      owner: { kind: 'workplace', workplaceId: w.workplaceId },
      serviceCode: 'scaling',
      pricing: { kind: 'range', minRial: '3500000', maxRial: '3500000' },
      reason: 'جرم‌گیری',
    });
    expect(scaling.status).toBe(201);
    // The two-person path is the way in.
    const made = await propose(proposer);
    expect((await decide(second, made.body['id'] as string, 'approve')).status).toBe(201);
  });
});

/** A manager of the world's center (catalog.manage_tariffs for its workplaces). */
async function centerManager() {
  const center = await w.staff(w.specialist, 'GET', `/catalog/centers/${w.centerId}`);
  const manager = await loggedInAccount(h, 'center');
  await grantRole(h, manager.id, 'center_manager', {
    kind: 'center',
    nodeId: center.body['nodeId'] as string,
  });
  return manager;
}
