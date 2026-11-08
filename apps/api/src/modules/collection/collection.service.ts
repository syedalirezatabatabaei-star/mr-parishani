import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  bucketOf,
  formatJalaliDate,
  formatToman,
  gregorianDay,
  gregorianToJalali,
  STAGE_TASK,
  stagesReached,
  toJalali,
  toPersianDigits,
  TWO_PERSON_STAGES,
  type BorrowerStatusKind,
  type CollectionCloseReason,
  type CollectionItemView,
  type CollectionQueueRow,
  type CollectionTaskKind,
  type PermissionCode,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { ASSIGNMENT_ENGINE, type AssignmentEngine } from '../../common/lead/assignment-engine.port';
import {
  INSTRUMENT_LEGAL,
  type InstrumentLegal,
} from '../../common/instrument/instrument-legal.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  NOTIFICATIONS,
  type NotificationsPort,
} from '../../common/notification/notifications.port';
import type { BorrowerSmsHold } from '../../common/repayment/borrower-sms-hold.port';
import {
  REPAYMENT,
  type OverdueCase,
  type RepaymentPort,
} from '../../common/repayment/repayment.port';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { WALLET, type WalletPort } from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';
import { scannerUnavailable } from '../../infra/clamd';
import { detectDocumentType } from '../../infra/file-type';
import { storageUnavailable } from '../../infra/s3-storage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUEUE = 'collection';

const iso = (v: unknown) => new Date(v as string).toISOString();
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(v));
const todayOf = (now: Date) => gregorianDay(toJalali(now));

function need(access: EffectiveAccess, permission: PermissionCode) {
  if (!access.permissions.has(permission)) {
    throw new ForbiddenException({ error: 'permission_required', permission });
  }
}

interface ItemRow extends Record<string, unknown> {
  id: string;
  case_id: string;
  opened_at: string;
  assignee_account_id: string | null;
  closed_at: string | null;
  close_reason: CollectionCloseReason | null;
}

interface TaskRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  case_id: string;
  stage: number;
  kind: CollectionTaskKind;
  status: 'open' | 'proposed' | 'done' | 'dismissed';
  proposed_by: string | null;
}

/**
 * The collection unit's work (task 6-7; doc 15 §5; owner 1405/07/16): the overdue queue, kept
 * nightly from repayment's port and assigned by the lead module's engine (3-5); actions and
 * payment promises; escalation that only makes tasks (the guarantor's SMS sent only by a
 * person's decision; stage 3 and 4 decided by the collection manager, never the proposer);
 * a borrower's deceased or disabled status, by two people with a document, which holds the
 * borrower's automatic SMS (BORROWER_SMS_HOLD). No treatment, doctor or center ever leaves
 * here; nothing here posts, allocates or changes an installment.
 */
@Injectable()
export class CollectionService implements BorrowerSmsHold {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(REPAYMENT) private readonly repayment: RepaymentPort,
    @Inject(WALLET) private readonly wallet: WalletPort,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(ASSIGNMENT_ENGINE) private readonly engine: AssignmentEngine,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    // The worker provides these three itself; resolved wherever they are, when first used.
    private readonly moduleRef: ModuleRef,
  ) {}

  private get facts(): CreditContractFactsPort {
    return this.moduleRef.get<CreditContractFactsPort>(CREDIT_CONTRACT_FACTS, { strict: false });
  }

  private get accounts(): AccountDirectory {
    return this.moduleRef.get<AccountDirectory>(ACCOUNT_DIRECTORY, { strict: false });
  }

  private get notifications(): NotificationsPort {
    return this.moduleRef.get<NotificationsPort>(NOTIFICATIONS, { strict: false });
  }

  // --- the hold (task 6-6's port) ---------------------------------------------------------

  /** Deceased or disabled, approved, and not lifted since: any of the person's merged ids. */
  async isHeld(personId: string, tx?: SqlExecutor): Promise<boolean> {
    if (!UUID.test(personId)) return false;
    const ids = await this.leads.samePersonIds(personId, tx);
    const row = (
      await (tx ?? this.db).execute(sql`
        SELECT kind FROM borrower_status_events
        WHERE person_id IN (${sql.join(
          (ids.length > 0 ? ids : [personId]).map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          AND approved_at IS NOT NULL
        ORDER BY approved_at DESC, id DESC LIMIT 1
      `)
    ).rows[0];
    return row !== undefined && row['kind'] !== 'lifted';
  }

  // --- the nightly cycle -------------------------------------------------------------------

  /**
   * Idempotent, after repayment's cycle: overdue cases opened in the queue and assigned; items
   * no longer overdue closed (cured, or settled when nothing is owed); promises due judged;
   * each stage reached a task, once.
   */
  async runCycle(
    actor: Actor,
    now = new Date(),
  ): Promise<{ opened: number; closed: number; kept: number; broken: number; tasks: number }> {
    const overdue = new Map((await this.repayment.overdueCases(now)).map((o) => [o.caseId, o]));
    const open = await this.openItems();
    let closed = 0;
    for (const item of open) {
      if (overdue.has(item.case_id)) continue;
      const owing = await this.repayment.casesWithOutstanding([item.case_id]);
      if (await this.close(actor, item.id, owing.length > 0 ? 'cured' : 'settled')) closed += 1;
    }
    const openCases = new Set(open.map((i) => i.case_id));
    let opened = 0;
    for (const o of overdue.values()) {
      if (openCases.has(o.caseId)) continue;
      if (await this.open(actor, o.caseId, now)) opened += 1;
    }
    const { kept, broken } = await this.judgePromises(actor, now);
    const tasks = await this.escalate(overdue, now);
    return { opened, closed, kept, broken, tasks };
  }

  private async openItems(): Promise<ItemRow[]> {
    return (
      await this.db.execute(sql`
        SELECT id, case_id, opened_at, assignee_account_id, closed_at, close_reason
        FROM collection_items WHERE closed_at IS NULL ORDER BY opened_at, id
      `)
    ).rows as ItemRow[];
  }

  private async open(actor: Actor, caseId: string, now: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const made = (
        await tx.execute(sql`
          INSERT INTO collection_items (case_id) VALUES (${caseId})
          ON CONFLICT (case_id) WHERE closed_at IS NULL DO NOTHING
          RETURNING id
        `)
      ).rows[0];
      if (!made) return false;
      const itemId = made['id'] as string;
      await this.assignAuto(tx, actor, itemId, caseId, now);
      await this.audit.record(
        {
          actor,
          action: 'collection.item_opened',
          entityType: 'collection_item',
          entityId: itemId,
          after: { caseId },
        },
        tx,
      );
      return true;
    });
  }

  private async close(actor: Actor, itemId: string, reason: CollectionCloseReason) {
    return this.db.transaction(async (tx) => {
      const done = await tx.execute(sql`
        UPDATE collection_items SET closed_at = now(), close_reason = ${reason}
        WHERE id = ${itemId} AND closed_at IS NULL RETURNING id
      `);
      if (done.rows.length === 0) return false;
      // Its open promises and tasks lose their object: cancelled and dismissed, recorded.
      await tx.execute(sql`
        UPDATE payment_promises SET status = 'cancelled', cancel_reason = ${`item_${reason}`}
        WHERE item_id = ${itemId} AND status = 'open'
      `);
      await tx.execute(sql`
        UPDATE collection_tasks
        SET status = 'dismissed', decided_at = now(), decision_note = ${`item_${reason}`}
        WHERE item_id = ${itemId} AND status IN ('open', 'proposed')
      `);
      await this.audit.record(
        {
          actor,
          action: 'collection.item_closed',
          entityType: 'collection_item',
          entityId: itemId,
          after: { reason },
        },
        tx,
      );
      return true;
    });
  }

  /** By the engine (3-5), or to the last agent of a case back in the queue when so set. */
  private async assignAuto(
    tx: SqlExecutor,
    actor: Actor,
    itemId: string,
    caseId: string,
    now: Date,
  ) {
    const sameAgent = await this.config.resolve('collection.same_agent_for_returning', {}, now);
    if (sameAgent.value) {
      const last = (
        await tx.execute(sql`
          SELECT assignee_account_id FROM collection_items
          WHERE case_id = ${caseId} AND closed_at IS NOT NULL AND assignee_account_id IS NOT NULL
          ORDER BY closed_at DESC, id DESC LIMIT 1
        `)
      ).rows[0]?.['assignee_account_id'] as string | undefined;
      const account = last ? await this.accounts.find(last) : null;
      if (last && account?.kind === 'staff' && account.status === 'active') {
        await this.recordAssignment(tx, actor, itemId, last, 'returning', null, null);
        return;
      }
    }
    const facts = await this.leads.caseFacts(caseId, tx);
    const pick = await this.engine.pick(
      tx,
      {
        queueCode: QUEUE,
        cityCode: facts?.cityCode ?? null,
        treatmentFieldCode: facts?.treatmentFieldCode ?? null,
      },
      (ids) => this.openCounts(tx, ids),
      now,
    );
    await this.recordAssignment(
      tx,
      actor,
      itemId,
      pick?.accountId ?? null,
      pick ? 'auto' : 'unassigned',
      pick?.weightVersionId ?? null,
      null,
    );
  }

  private async recordAssignment(
    tx: SqlExecutor,
    actor: Actor,
    itemId: string,
    accountId: string | null,
    kind: 'auto' | 'returning' | 'manual' | 'unassigned',
    weightVersionId: string | null,
    reason: string | null,
  ) {
    await tx.execute(sql`
      INSERT INTO collection_assignments (item_id, account_id, kind, weight_version_id, reason, created_by)
      VALUES (${itemId}, ${accountId}, ${kind}, ${weightVersionId}, ${reason}, ${actor.accountId})
    `);
    await tx.execute(sql`
      UPDATE collection_items SET assignee_account_id = ${accountId} WHERE id = ${itemId}
    `);
  }

  private async openCounts(tx: SqlExecutor, ids: readonly string[]) {
    if (ids.length === 0) return new Map<string, number>();
    const rows = await tx.execute(sql`
      SELECT assignee_account_id, count(*)::int AS n FROM collection_items
      WHERE closed_at IS NULL AND assignee_account_id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      GROUP BY assignee_account_id
    `);
    return new Map(rows.rows.map((r) => [r['assignee_account_id'] as string, Number(r['n'])]));
  }

  /** Doc 15 §5: on its day, kept if what was allocated since it was made covers it. */
  private async judgePromises(actor: Actor, now: Date) {
    const due = (
      await this.db.execute(sql`
        SELECT id, item_id, case_id, promised_amount_rial::text AS amount, created_at
        FROM payment_promises WHERE status = 'open' AND promised_on <= ${todayOf(now)}::date
        ORDER BY promised_on, id
      `)
    ).rows;
    let kept = 0;
    let broken = 0;
    for (const p of due) {
      const allocated = await this.repayment.allocatedSince(
        p['case_id'] as string,
        new Date(p['created_at'] as string),
      );
      const isKept = allocated >= BigInt(p['amount'] as string);
      const judged = await this.db.transaction(async (tx) => {
        const done = await tx.execute(sql`
          UPDATE payment_promises
          SET status = ${isKept ? 'kept' : 'broken'}, evaluated_at = now(),
              allocated_rial = ${allocated.toString()}::bigint
          WHERE id = ${p['id'] as string} AND status = 'open' RETURNING id
        `);
        if (done.rows.length === 0) return false;
        if (!isKept) {
          // The agent told: a task on the item (doc 15 §5's alert).
          await tx.execute(sql`
            INSERT INTO collection_tasks (item_id, case_id, stage, kind, promise_id)
            VALUES (${p['item_id'] as string}, ${p['case_id'] as string}, 1, 'promise_broken',
                    ${p['id'] as string})
            ON CONFLICT (promise_id) WHERE promise_id IS NOT NULL DO NOTHING
          `);
        }
        await this.audit.record(
          {
            actor,
            action: isKept ? 'collection.promise_kept' : 'collection.promise_broken',
            entityType: 'payment_promise',
            entityId: p['id'] as string,
            after: { allocatedRial: allocated.toString(), promisedRial: p['amount'] as string },
          },
          tx,
        );
        return true;
      });
      if (judged && isKept) kept += 1;
      if (judged && !isKept) broken += 1;
    }
    return { kept, broken };
  }

  /** Each stage reached (1 to 3, by the rules in force), its task, once. */
  private async escalate(overdue: ReadonlyMap<string, OverdueCase>, now: Date) {
    const rules = (await this.config.resolve('collection.escalation_rules', {}, now)).value;
    let made = 0;
    for (const item of await this.openItems()) {
      const o = overdue.get(item.case_id);
      if (!o) continue;
      for (const stage of stagesReached(o.maxDaysPastDue, o.overdueInstallments, rules)) {
        if (await this.addTask(item.id, item.case_id, stage)) made += 1;
      }
    }
    return made;
  }

  private async addTask(itemId: string, caseId: string, stage: number): Promise<boolean> {
    const kind = STAGE_TASK[stage];
    if (!kind) return false;
    const made = await this.db.execute(sql`
      INSERT INTO collection_tasks (item_id, case_id, stage, kind)
      VALUES (${itemId}, ${caseId}, ${stage}, ${kind})
      ON CONFLICT (item_id, stage, kind) WHERE promise_id IS NULL DO NOTHING
      RETURNING id
    `);
    return made.rows.length > 0;
  }

  /**
   * Stage 4 (doc 15 §5): after a cheque bounced, a legal referral to propose. Task 6-8's
   * cheque execution calls this; nothing calls it before.
   */
  async chequeBounced(caseId: string): Promise<boolean> {
    const item = (
      await this.db.execute(sql`
        SELECT id FROM collection_items WHERE case_id = ${caseId} AND closed_at IS NULL
      `)
    ).rows[0];
    return item ? this.addTask(item['id'] as string, caseId, 4) : false;
  }

  // --- reading -----------------------------------------------------------------------------

  /** Everything (global scope) or one's own items; nothing for any other scope. */
  private reach(access: EffectiveAccess): 'all' | 'own' | null {
    if (access.scopes.some((s) => s.kind === 'global')) return 'all';
    if (access.scopes.some((s) => s.kind === 'own')) return 'own';
    return null;
  }

  /** An item the caller may see; otherwise it does not exist (rule 13). */
  private async visibleItem(
    ex: SqlExecutor,
    actor: Actor,
    access: EffectiveAccess,
    itemId: string,
    lock = false,
  ): Promise<ItemRow> {
    const notFound = new NotFoundException({ error: 'collection_item_not_found' });
    if (!UUID.test(itemId)) throw notFound;
    const reach = this.reach(access);
    if (reach === null) throw notFound;
    const row = (
      await ex.execute(sql`
        SELECT id, case_id, opened_at, assignee_account_id, closed_at, close_reason
        FROM collection_items WHERE id = ${itemId} ${lock ? sql`FOR UPDATE` : sql``}
      `)
    ).rows[0] as ItemRow | undefined;
    if (!row) throw notFound;
    if (reach === 'own' && row.assignee_account_id !== actor.accountId) throw notFound;
    return row;
  }

  private async borrowerOf(caseId: string, overdue?: OverdueCase) {
    const purseId =
      overdue?.purseIds[0] ??
      (await (async () => {
        const [scheduleId] = await this.repayment.schedulesOf(caseId);
        return scheduleId ? (await this.repayment.schedule(scheduleId)).purseId : null;
      })());
    if (!purseId) return null;
    const purse = await this.wallet.summary(purseId);
    const personId = purse.borrowerPersonId;
    const [name, mobile, held] = await Promise.all([
      this.leads.displayNameOf(personId),
      this.leads.mobileOf(personId),
      this.isHeld(personId),
    ]);
    return { personId, name, mobile, held, creditApplicationId: purse.creditApplicationId };
  }

  async queue(
    actor: Actor,
    access: EffectiveAccess,
    query: { bucket?: number | undefined; mine?: 'true' | 'false' | undefined },
    now = new Date(),
  ): Promise<CollectionQueueRow[]> {
    need(access, 'collection.read_queue');
    const reach = this.reach(access);
    if (reach === null) return [];
    const mine = reach === 'own' || query.mine === 'true';
    const rows = (
      await this.db.execute(sql`
        SELECT i.id, i.case_id, i.opened_at, i.assignee_account_id,
               (SELECT count(*)::int FROM collection_tasks t
                WHERE t.item_id = i.id AND t.status IN ('open', 'proposed')) AS open_tasks
        FROM collection_items i
        WHERE i.closed_at IS NULL
          ${mine ? sql`AND i.assignee_account_id = ${actor.accountId}` : sql``}
        ORDER BY i.opened_at, i.id
        LIMIT 1000
      `)
    ).rows;
    const overdue = new Map((await this.repayment.overdueCases(now)).map((o) => [o.caseId, o]));
    const buckets = (await this.config.resolve('collection.buckets', {}, now)).value;
    const out: CollectionQueueRow[] = [];
    for (const r of rows) {
      const caseId = r['case_id'] as string;
      const o = overdue.get(caseId);
      const bucket = o ? (bucketOf(o.maxDaysPastDue, buckets)?.index ?? null) : null;
      if (query.bucket !== undefined && bucket !== query.bucket) continue;
      const borrower = await this.borrowerOf(caseId, o);
      out.push({
        itemId: r['id'] as string,
        caseId,
        borrowerName: borrower?.name ?? null,
        borrowerMobile: borrower?.mobile ?? null,
        maxDaysPastDue: o?.maxDaysPastDue ?? 0,
        overdueInstallments: o?.overdueInstallments ?? 0,
        overdueRial: (o?.overdueRial ?? 0n).toString(),
        bucket,
        assigneeAccountId: (r['assignee_account_id'] as string | null) ?? null,
        openedAt: iso(r['opened_at']),
        openTasks: Number(r['open_tasks']),
        borrowerHeld: borrower?.held ?? false,
      });
    }
    return out;
  }

  /** The queue as CSV (doc 15 §9 test 5: the same fields, no treatment). */
  async queueCsv(
    actor: Actor,
    access: EffectiveAccess,
    query: { bucket?: number | undefined; mine?: 'true' | 'false' | undefined },
  ): Promise<string> {
    const rows = await this.queue(actor, access, query);
    const cell = (v: string | number | boolean | null) => {
      const s = v === null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = [
      'itemId',
      'caseId',
      'borrowerName',
      'borrowerMobile',
      'maxDaysPastDue',
      'overdueInstallments',
      'overdueRial',
      'bucket',
      'assigneeAccountId',
      'openedAt',
      'openTasks',
    ] as const;
    const lines = rows.map((r) => head.map((k) => cell(r[k])).join(','));
    return `${String.fromCharCode(0xfeff)}${[head.join(','), ...lines].join('\r\n')}\r\n`;
  }

  async item(
    actor: Actor,
    access: EffectiveAccess,
    itemId: string,
    now = new Date(),
  ): Promise<CollectionItemView> {
    need(access, 'collection.read_queue');
    const item = await this.visibleItem(this.db, actor, access, itemId);
    const borrower = await this.borrowerOf(item.case_id);
    const installments = [];
    for (const scheduleId of await this.repayment.schedulesOf(item.case_id)) {
      const s = await this.repayment.schedule(scheduleId, now);
      for (const i of s.installments) {
        installments.push({
          scheduleId,
          index: i.index,
          dueOn: i.dueOn,
          amountRial: i.amountRial.toString(),
          paidRial: i.paidRial.toString(),
          outstandingRial: i.outstandingRial.toString(),
          status: i.status,
          daysPastDue: i.daysPastDue,
        });
      }
    }
    const guarantors = await this.guarantorsOf(borrower?.creditApplicationId ?? null);
    const payments = (await this.repayment.paymentsOf(item.case_id)).map((p) => ({
      paymentId: p.paymentId,
      amountRial: p.amountRial.toString(),
      status: p.status,
      receivedAt: p.receivedAt.toISOString(),
    }));
    const [actions, promises, tasks] = await Promise.all([
      this.db.execute(sql`
        SELECT id, kind, outcome, note, occurred_at, next_follow_up_at, actor_account_id
        FROM collection_actions WHERE item_id = ${item.id} ORDER BY occurred_at DESC, id DESC
      `),
      this.db.execute(sql`
        SELECT id, promised_amount_rial::text AS amount, promised_on::text AS promised_on, status,
               allocated_rial::text AS allocated, created_at
        FROM payment_promises WHERE item_id = ${item.id} ORDER BY created_at DESC, id DESC
      `),
      this.db.execute(sql`
        SELECT id, stage, kind, status, created_at, proposed_by, decided_by
        FROM collection_tasks WHERE item_id = ${item.id} ORDER BY created_at, id
      `),
    ]);
    return {
      itemId: item.id,
      caseId: item.case_id,
      openedAt: iso(item.opened_at),
      closedAt: isoOrNull(item.closed_at),
      closeReason: item.close_reason,
      assigneeAccountId: item.assignee_account_id,
      borrower: {
        personId: borrower?.personId ?? '00000000-0000-0000-0000-000000000000',
        name: borrower?.name ?? null,
        mobile: borrower?.mobile ?? null,
        held: borrower?.held ?? false,
      },
      guarantors: guarantors.map((g) => ({
        guarantorId: g.guarantorId,
        name: g.name,
        mobile: g.mobile,
      })),
      installments,
      payments,
      actions: actions.rows.map((a) => ({
        id: a['id'] as string,
        kind: a['kind'] as CollectionItemView['actions'][number]['kind'],
        outcome: a['outcome'] as string,
        note: (a['note'] as string | null) ?? null,
        occurredAt: iso(a['occurred_at']),
        nextFollowUpAt: isoOrNull(a['next_follow_up_at']),
        actorAccountId: (a['actor_account_id'] as string | null) ?? null,
      })),
      promises: promises.rows.map((p) => ({
        id: p['id'] as string,
        amountRial: p['amount'] as string,
        promisedOn: p['promised_on'] as string,
        status: p['status'] as CollectionItemView['promises'][number]['status'],
        allocatedRial: (p['allocated'] as string | null) ?? null,
        createdAt: iso(p['created_at']),
      })),
      tasks: tasks.rows.map((t) => ({
        id: t['id'] as string,
        stage: Number(t['stage']),
        kind: t['kind'] as CollectionTaskKind,
        status: t['status'] as CollectionItemView['tasks'][number]['status'],
        createdAt: iso(t['created_at']),
        proposedBy: (t['proposed_by'] as string | null) ?? null,
        decidedBy: (t['decided_by'] as string | null) ?? null,
      })),
    };
  }

  /** The loan's guarantors, by name and mobile only (doc 15 §5). */
  private async guarantorsOf(creditApplicationId: string | null) {
    if (!creditApplicationId) return [];
    const facts = await this.facts.facts(creditApplicationId);
    const out = [];
    for (const g of facts?.guarantors ?? []) {
      const [name, mobile] = await Promise.all([
        this.leads.displayNameOf(g.personId),
        this.leads.mobileOf(g.personId),
      ]);
      out.push({ guarantorId: g.id, personId: g.personId, name, mobile });
    }
    return out;
  }

  /** The text an SMS would carry to the borrower or a guarantor; nothing sent. */
  async smsPreview(
    actor: Actor,
    access: EffectiveAccess,
    itemId: string,
    audience: 'borrower' | 'guarantor',
    now = new Date(),
  ) {
    need(access, 'collection.read_queue');
    const item = await this.visibleItem(this.db, actor, access, itemId);
    const values = await this.smsValues(item.case_id, now);
    if (audience === 'borrower') {
      // The overdue notice of task 6-6, for the oldest installment still owed.
      let oldest: { index: number; dueOn: string; outstandingRial: bigint } | null = null;
      for (const scheduleId of await this.repayment.schedulesOf(item.case_id)) {
        for (const i of (await this.repayment.schedule(scheduleId, now)).installments) {
          if (i.status === 'overdue' && (!oldest || i.dueOn < oldest.dueOn)) oldest = i;
        }
      }
      const [y, m, d] = (oldest?.dueOn ?? todayOf(now)).split('-').map(Number);
      const templateCode = 'repayment.overdue_notice';
      const text = await this.notifications.preview(templateCode, 'borrower', {
        name: values.borrowerName,
        installment_number: toPersianDigits(oldest?.index ?? 0),
        amount: formatToman(oldest?.outstandingRial ?? 0n),
        due_date: formatJalaliDate(gregorianToJalali({ year: y ?? 0, month: m ?? 0, day: d ?? 0 })),
        days_overdue: values.days,
      });
      return { audience, templateCode, text };
    }
    const templateCode = 'repayment.guarantor_notice';
    const text = await this.notifications.preview(templateCode, 'guarantor', {
      name: values.guarantorName,
      borrower_name: values.borrowerName,
      amount: values.amount,
      days_overdue: values.days,
    });
    return { audience, templateCode, text };
  }

  private async smsValues(caseId: string, now: Date) {
    const o = (await this.repayment.overdueCases(now)).find((c) => c.caseId === caseId);
    const borrower = await this.borrowerOf(caseId, o);
    const [first] = await this.guarantorsOf(borrower?.creditApplicationId ?? null);
    return {
      borrowerName: borrower?.name ?? 'مشتری',
      guarantorName: first?.name ?? 'ضامن',
      amount: formatToman(o?.overdueRial ?? 0n),
      days: toPersianDigits(o?.maxDaysPastDue ?? 0),
      overdue: o,
      borrower,
    };
  }

  // --- the agent's work --------------------------------------------------------------------

  async recordAction(
    actor: Actor,
    access: EffectiveAccess,
    itemId: string,
    input: {
      kind: CollectionItemView['actions'][number]['kind'];
      outcome: string;
      note?: string | undefined;
      occurredAt: string;
      nextFollowUpAt?: string | undefined;
    },
  ) {
    need(access, 'collection.record_action');
    return this.db.transaction(async (tx) => {
      const item = await this.visibleItem(tx, actor, access, itemId, true);
      if (item.closed_at) throw new ConflictException({ error: 'collection_item_closed' });
      const id = await this.insertAction(tx, actor, item, input);
      await this.audit.record(
        {
          actor,
          action: 'collection.action_recorded',
          entityType: 'collection_item',
          entityId: item.id,
          after: { actionId: id, kind: input.kind, outcome: input.outcome },
        },
        tx,
      );
      return { id };
    });
  }

  private async insertAction(
    tx: SqlExecutor,
    actor: Actor,
    item: ItemRow,
    input: {
      kind: string;
      outcome: string;
      note?: string | undefined;
      occurredAt: string;
      nextFollowUpAt?: string | undefined;
    },
  ): Promise<string> {
    const made = await tx.execute(sql`
      INSERT INTO collection_actions (item_id, case_id, actor_account_id, kind, outcome, note,
                                      occurred_at, next_follow_up_at)
      VALUES (${item.id}, ${item.case_id}, ${actor.accountId}, ${input.kind}, ${input.outcome},
              ${input.note ?? null}, ${input.occurredAt}, ${input.nextFollowUpAt ?? null})
      RETURNING id
    `);
    return made.rows[0]?.['id'] as string;
  }

  async createPromise(
    actor: Actor,
    access: EffectiveAccess,
    itemId: string,
    input: { amountRial: bigint; promisedOn: string; note?: string | undefined },
    now = new Date(),
  ) {
    need(access, 'collection.manage_promises');
    if (input.promisedOn < todayOf(now)) {
      throw new BadRequestException({ error: 'promised_on_past' });
    }
    return this.db.transaction(async (tx) => {
      const item = await this.visibleItem(tx, actor, access, itemId, true);
      if (item.closed_at) throw new ConflictException({ error: 'collection_item_closed' });
      const made = await tx.execute(sql`
        INSERT INTO payment_promises (item_id, case_id, promised_amount_rial, promised_on, note, created_by)
        VALUES (${item.id}, ${item.case_id}, ${input.amountRial.toString()}::bigint,
                ${input.promisedOn}::date, ${input.note ?? null}, ${actor.accountId})
        RETURNING id
      `);
      const id = made.rows[0]?.['id'] as string;
      await this.audit.record(
        {
          actor,
          action: 'collection.promise_made',
          entityType: 'payment_promise',
          entityId: id,
          after: { itemId: item.id, amountRial: input.amountRial.toString(), on: input.promisedOn },
        },
        tx,
      );
      return { id };
    });
  }

  async cancelPromise(actor: Actor, access: EffectiveAccess, promiseId: string, reason: string) {
    need(access, 'collection.manage_promises');
    if (!UUID.test(promiseId)) throw new NotFoundException({ error: 'promise_not_found' });
    return this.db.transaction(async (tx) => {
      const p = (
        await tx.execute(sql`
          SELECT id, item_id, status FROM payment_promises WHERE id = ${promiseId} FOR UPDATE
        `)
      ).rows[0];
      if (!p) throw new NotFoundException({ error: 'promise_not_found' });
      await this.visibleItem(tx, actor, access, p['item_id'] as string);
      if (p['status'] !== 'open') {
        throw new ConflictException({ error: 'promise_not_open', status: p['status'] });
      }
      await tx.execute(sql`
        UPDATE payment_promises SET status = 'cancelled', cancelled_by = ${actor.accountId},
               cancel_reason = ${reason}
        WHERE id = ${promiseId}
      `);
      await this.audit.record(
        {
          actor,
          action: 'collection.promise_cancelled',
          entityType: 'payment_promise',
          entityId: promiseId,
          reason,
        },
        tx,
      );
      return { id: promiseId, status: 'cancelled' as const };
    });
  }

  private async lockTask(
    tx: SqlExecutor,
    actor: Actor,
    access: EffectiveAccess,
    taskId: string,
  ): Promise<{ task: TaskRow; item: ItemRow }> {
    if (!UUID.test(taskId)) throw new NotFoundException({ error: 'task_not_found' });
    const task = (
      await tx.execute(sql`
        SELECT id, item_id, case_id, stage, kind, status, proposed_by
        FROM collection_tasks WHERE id = ${taskId} FOR UPDATE
      `)
    ).rows[0] as TaskRow | undefined;
    if (!task) throw new NotFoundException({ error: 'task_not_found' });
    const item = await this.visibleItem(tx, actor, access, task.item_id);
    return { task, item };
  }

  /** Stage 1 and 2 tasks and broken promises: done or dismissed by the agent, with a note. */
  async workTask(
    actor: Actor,
    access: EffectiveAccess,
    taskId: string,
    input: { outcome: 'done' | 'dismissed'; note: string },
  ) {
    need(access, 'collection.work_tasks');
    return this.db.transaction(async (tx) => {
      const { task } = await this.lockTask(tx, actor, access, taskId);
      if (TWO_PERSON_STAGES.includes(task.stage)) {
        throw new ConflictException({ error: 'two_person_stage' });
      }
      // The guarantor is told only through the send action (owner: a person's decision).
      if (task.kind === 'guarantor_notice' && input.outcome === 'done') {
        throw new ConflictException({ error: 'send_guarantor_sms_instead' });
      }
      if (task.status !== 'open') throw new ConflictException({ error: 'task_not_open' });
      await this.decide(tx, actor, task, input.outcome, input.note, 'collection.task_worked');
      return { id: task.id, status: input.outcome };
    });
  }

  /**
   * Stage 2 (owner 1405/07/16): never automatic; the agent decides, with a reason, and each
   * guarantor with a mobile gets the guarantor template once: no treatment, doctor or center
   * (its fields are the guarantor's allowed ones, task 6-4). Recorded as an action.
   */
  async sendGuarantorSms(
    actor: Actor,
    access: EffectiveAccess,
    taskId: string,
    reason: string,
    now = new Date(),
  ) {
    need(access, 'collection.work_tasks');
    return this.db.transaction(async (tx) => {
      const { task, item } = await this.lockTask(tx, actor, access, taskId);
      if (task.kind !== 'guarantor_notice')
        throw new ConflictException({ error: 'not_guarantor_task' });
      if (task.status !== 'open') throw new ConflictException({ error: 'task_not_open' });
      const values = await this.smsValues(item.case_id, now);
      const guarantors = (
        await this.guarantorsOf(values.borrower?.creditApplicationId ?? null)
      ).filter((g) => g.mobile);
      if (guarantors.length === 0) throw new ConflictException({ error: 'no_guarantor_mobile' });
      const sent: string[] = [];
      for (const g of guarantors) {
        const sms = await this.notifications.send(
          {
            templateCode: 'repayment.guarantor_notice',
            audience: 'guarantor',
            mobile: g.mobile as string,
            personId: g.personId,
            values: {
              name: g.name ?? 'ضامن',
              borrower_name: values.borrowerName,
              amount: values.amount,
              days_overdue: values.days,
            },
            idempotencyKey: `collection:guarantor:${item.id}:${g.guarantorId}:stage${String(task.stage)}`,
          },
          tx,
        );
        sent.push(sms.dispatchId);
      }
      await this.insertAction(tx, actor, item, {
        kind: 'guarantor_contact',
        outcome: 'sms_sent',
        note: reason,
        occurredAt: now.toISOString(),
      });
      await this.decide(tx, actor, task, 'done', reason, 'collection.guarantor_sms_sent');
      return { id: task.id, status: 'done' as const, dispatchIds: sent };
    });
  }

  /** Stage 3 and 4: the agent proposes, with a note; the collection manager decides. */
  async proposeTask(actor: Actor, access: EffectiveAccess, taskId: string, note: string) {
    need(access, 'collection.work_tasks');
    return this.db.transaction(async (tx) => {
      const { task } = await this.lockTask(tx, actor, access, taskId);
      if (!TWO_PERSON_STAGES.includes(task.stage)) {
        throw new ConflictException({ error: 'not_two_person_stage' });
      }
      if (task.status !== 'open') throw new ConflictException({ error: 'task_not_open' });
      await tx.execute(sql`
        UPDATE collection_tasks SET status = 'proposed', proposed_by = ${actor.accountId},
               proposed_at = now(), proposal_note = ${note}
        WHERE id = ${task.id}
      `);
      await this.audit.record(
        {
          actor,
          action: 'collection.task_proposed',
          entityType: 'collection_task',
          entityId: task.id,
          after: { stage: task.stage, kind: task.kind },
          reason: note,
        },
        tx,
      );
      return { id: task.id, status: 'proposed' as const };
    });
  }

  /** Task 6-9: stage 3 and 4 proposals waiting for the collection manager, oldest first. */
  async proposedTasks(access: EffectiveAccess) {
    need(access, 'collection.decide_escalation');
    if (this.reach(access) !== 'all') return [];
    const rows = await this.db.execute(sql`
      SELECT id, item_id, case_id, stage, kind, proposed_by, proposal_note,
             to_char(proposed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS proposed_at
      FROM collection_tasks WHERE status = 'proposed'
      ORDER BY proposed_at, id
    `);
    return rows.rows.map((r) => ({
      taskId: r['id'] as string,
      itemId: r['item_id'] as string,
      caseId: r['case_id'] as string,
      stage: r['stage'] as number,
      kind: r['kind'] as CollectionTaskKind,
      proposedBy: (r['proposed_by'] as string | null) ?? null,
      proposalNote: (r['proposal_note'] as string | null) ?? null,
      proposedAt: (r['proposed_at'] as string | null) ?? null,
    }));
  }

  /** The collection manager only, never on their own proposal (doc 15 §5; owner). */
  async decideEscalation(
    actor: Actor,
    access: EffectiveAccess,
    taskId: string,
    input: { decision: 'done' | 'dismissed'; note: string },
  ) {
    need(access, 'collection.decide_escalation');
    return this.db.transaction(async (tx) => {
      const { task } = await this.lockTask(tx, actor, access, taskId);
      if (!TWO_PERSON_STAGES.includes(task.stage)) {
        throw new ConflictException({ error: 'not_two_person_stage' });
      }
      if (task.status !== 'proposed') throw new ConflictException({ error: 'task_not_proposed' });
      if (task.proposed_by === actor.accountId) {
        throw new ConflictException({ error: 'same_person' });
      }
      await this.decide(
        tx,
        actor,
        task,
        input.decision,
        input.note,
        'collection.escalation_decided',
      );
      // Task 6-8: a legal referral decided sends the case's bounced cheques to legal action.
      if (task.kind === 'legal_referral' && input.decision === 'done') {
        await this.moduleRef
          .get<InstrumentLegal>(INSTRUMENT_LEGAL, { strict: false })
          .referToLegal(actor, task.case_id, tx);
      }
      return { id: task.id, status: input.decision };
    });
  }

  private async decide(
    tx: SqlExecutor,
    actor: Actor,
    task: TaskRow,
    status: 'done' | 'dismissed',
    note: string,
    action: string,
  ) {
    await tx.execute(sql`
      UPDATE collection_tasks SET status = ${status}, decided_by = ${actor.accountId},
             decided_at = now(), decision_note = ${note}
      WHERE id = ${task.id}
    `);
    await this.audit.record(
      {
        actor,
        action,
        entityType: 'collection_task',
        entityId: task.id,
        before: { status: task.status },
        after: { status, stage: task.stage, kind: task.kind },
        reason: note,
      },
      tx,
    );
  }

  /** By hand, with a reason, to an active staff account (doc 05 §6; as 3-5's queues). */
  async assignManually(
    actor: Actor,
    access: EffectiveAccess,
    itemId: string,
    input: { accountId: string; reason: string },
  ) {
    need(access, 'collection.assign');
    const account = await this.accounts.find(input.accountId);
    if (account?.kind !== 'staff' || account.status !== 'active') {
      throw new BadRequestException({ error: 'not_a_staff_account' });
    }
    return this.db.transaction(async (tx) => {
      const item = await this.visibleItem(tx, actor, access, itemId, true);
      if (item.closed_at) throw new ConflictException({ error: 'collection_item_closed' });
      await this.recordAssignment(
        tx,
        actor,
        item.id,
        input.accountId,
        'manual',
        null,
        input.reason,
      );
      await this.audit.record(
        {
          actor,
          action: 'collection.assigned_manually',
          entityType: 'collection_item',
          entityId: item.id,
          before: { assigneeAccountId: item.assignee_account_id },
          after: { assigneeAccountId: input.accountId },
          reason: input.reason,
        },
        tx,
      );
      return { itemId: item.id, assigneeAccountId: input.accountId };
    });
  }

  // --- deceased or disabled (doc 15 §5; owner: two people, a document, audited) -------------

  async proposeBorrowerStatus(
    actor: Actor,
    access: EffectiveAccess,
    input: { itemId: string; kind: BorrowerStatusKind; note: string },
    file: { buffer: Buffer } | undefined,
  ) {
    need(access, 'collection.propose_borrower_status');
    if (!file) throw new BadRequestException({ error: 'file_required' });
    const item = await this.visibleItem(this.db, actor, access, input.itemId);
    const borrower = await this.borrowerOf(item.case_id);
    if (!borrower) throw new ConflictException({ error: 'no_borrower' });
    if ((input.kind === 'lifted') !== borrower.held) {
      throw new ConflictException({ error: borrower.held ? 'already_held' : 'not_held' });
    }
    // Rule 28: scanned first, kept only if its bytes are a PDF, JPEG or PNG, in private space.
    if (!this.storage.configured) throw storageUnavailable();
    if (!this.scanner.configured) throw scannerUnavailable();
    const scan = await this.scanner.scan(file.buffer);
    if (!scan.clean) throw new BadRequestException({ error: 'file_infected' });
    const mime = detectDocumentType(file.buffer);
    if (!mime) throw new BadRequestException({ error: 'unsupported_type' });
    const id = (await this.db.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.['id'] as string;
    const key = `borrower-status/${borrower.personId}/${id}`;
    await this.storage.put('private', key, file.buffer, mime);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO borrower_status_events (id, person_id, kind, evidence_key, evidence_mime,
                                            evidence_sha256, note, proposed_by)
        VALUES (${id}, ${borrower.personId}, ${input.kind}, ${key}, ${mime}, ${sha256},
                ${input.note}, ${actor.accountId})
      `);
      await this.audit.record(
        {
          actor,
          action: 'collection.borrower_status_proposed',
          entityType: 'borrower_status',
          entityId: id,
          after: { personId: borrower.personId, kind: input.kind, itemId: item.id },
          reason: input.note,
        },
        tx,
      );
      return { id, status: 'proposed' as const };
    });
  }

  async approveBorrowerStatus(actor: Actor, access: EffectiveAccess, eventId: string) {
    need(access, 'collection.approve_borrower_status');
    if (!UUID.test(eventId)) throw new NotFoundException({ error: 'borrower_status_not_found' });
    return this.db.transaction(async (tx) => {
      const e = (
        await tx.execute(sql`
          SELECT id, person_id, kind, proposed_by, approved_at
          FROM borrower_status_events WHERE id = ${eventId} FOR UPDATE
        `)
      ).rows[0];
      if (!e) throw new NotFoundException({ error: 'borrower_status_not_found' });
      if (e['approved_at']) throw new ConflictException({ error: 'already_approved' });
      if (e['proposed_by'] === actor.accountId) {
        throw new ConflictException({ error: 'same_person' });
      }
      const before = await this.isHeld(e['person_id'] as string, tx);
      await tx.execute(sql`
        UPDATE borrower_status_events SET approved_by = ${actor.accountId}, approved_at = now()
        WHERE id = ${eventId}
      `);
      await this.audit.record(
        {
          actor,
          action: 'collection.borrower_status_approved',
          entityType: 'borrower_status',
          entityId: eventId,
          before: { held: before },
          after: { held: e['kind'] !== 'lifted', kind: e['kind'] },
        },
        tx,
      );
      return { id: eventId, status: 'approved' as const };
    });
  }

  /** Proposals awaiting approval, for the collection manager. */
  async pendingBorrowerStatus(access: EffectiveAccess) {
    need(access, 'collection.approve_borrower_status');
    const rows = await this.db.execute(sql`
      SELECT id, person_id, kind, proposed_by, approved_by, created_at, approved_at
      FROM borrower_status_events WHERE approved_at IS NULL ORDER BY created_at, id
    `);
    return rows.rows.map((r) => ({
      id: r['id'] as string,
      personId: r['person_id'] as string,
      kind: r['kind'] as BorrowerStatusKind,
      proposedBy: (r['proposed_by'] as string | null) ?? null,
      approvedBy: (r['approved_by'] as string | null) ?? null,
      createdAt: iso(r['created_at']),
      approvedAt: isoOrNull(r['approved_at']),
    }));
  }
}
