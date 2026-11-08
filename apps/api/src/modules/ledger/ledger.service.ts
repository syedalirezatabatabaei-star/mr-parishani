import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import {
  AUDIT_LOG,
  type Actor,
  type AuditLog,
  type SqlExecutor,
} from '../../common/audit/audit.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import type {
  AccountBalance,
  AccountOwnerType,
  CodeTotal,
  Direction,
  JournalLine,
  JournalRead,
  LedgerPort,
  OpenAccount,
  PostedJournal,
  PostedLine,
  PostJournal,
} from '../../common/ledger/ledger.port';
import { DATABASE, type Database } from '../../db/database.module';

const EVENT_TYPE = /^[a-z]+\.[a-z][a-z_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVERSAL_EVENT = 'ledger.reversal';
/** 2^63 − 1: the largest amount a bigint column holds. */
const MAX_RIAL = 9_223_372_036_854_775_807n;

interface JournalRow extends Record<string, unknown> {
  id: string;
  entity_id: string;
  event_type: string;
  occurred_at: string;
  idempotency_key: string;
  request_hash: string;
  case_id: string | null;
  credit_application_id: string | null;
  reverses_journal_entry_id: string | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

interface LineRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  direction: Direction;
  amount_rial: string;
}

/** Whether `error` (or its cause, as Drizzle wraps it) violated this constraint. */
function violates(error: unknown, constraint: string): boolean {
  for (
    let e: unknown = error;
    e !== null && typeof e === 'object';
    e = (e as { cause?: unknown }).cause
  ) {
    if ((e as { constraint?: unknown }).constraint === constraint) return true;
  }
  return false;
}

const invalid = (error: string, detail?: Record<string, unknown>) =>
  new BadRequestException({ error, ...detail });

/** The same request always hashes the same; money as strings (no JS bigint in JSON). */
function requestHash(input: PostJournal, reversesJournalEntryId: string | null): string {
  const canonical = JSON.stringify({
    entityId: input.entityId,
    eventType: input.eventType,
    occurredAt: input.occurredAt.toISOString(),
    caseId: input.caseId ?? null,
    creditApplicationId: input.creditApplicationId ?? null,
    reversesJournalEntryId,
    reason: input.reason ?? null,
    lines: input.lines.map((l) => [l.accountId, l.direction, l.amountRial.toString()]),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Validates a document before anything touches the database (doc 02 §1): at least two
 * lines, every amount a positive bigint of rials, and debits equal to credits. The
 * database checks balance again at commit (journal_entries_balanced).
 */
function validate(input: PostJournal): void {
  if (!EVENT_TYPE.test(input.eventType)) throw invalid('invalid_event_type');
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
    throw invalid('invalid_occurred_at');
  }
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw invalid('idempotency_key_required');
  }
  if (input.lines.length < 2) throw invalid('journal_needs_two_lines');
  let debits = 0n;
  let credits = 0n;
  for (const line of input.lines) {
    // Rule 1: a JS number (or anything else) is never an amount.
    if (typeof line.amountRial !== 'bigint') throw invalid('amount_must_be_bigint_rial');
    if (line.amountRial <= 0n || line.amountRial > MAX_RIAL) throw invalid('amount_out_of_range');
    if (!UUID.test(line.accountId)) throw invalid('invalid_account');
    // Typed, but checked anyway: callers are other modules, at run time.
    const direction: string = line.direction;
    if (direction === 'debit') debits += line.amountRial;
    else if (direction === 'credit') credits += line.amountRial;
    else throw invalid('invalid_direction');
  }
  if (debits !== credits) {
    throw invalid('unbalanced_journal', {
      debitRial: debits.toString(),
      creditRial: credits.toString(),
    });
  }
}

/**
 * The ledger (task 1-1, doc 02, ADR-004 and ADR-017). postJournal() is the only writer:
 * append-only documents of balanced entries, one per idempotency key, in the caller's
 * transaction when given. Balances are sums of entries, never stored (rule 4).
 */
@Injectable()
export class LedgerService implements LedgerPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  private inTransaction<T>(tx: SqlExecutor | undefined, fn: (ex: SqlExecutor) => Promise<T>) {
    return tx ? fn(tx) : this.db.transaction((own) => fn(own));
  }

  async openAccount(input: OpenAccount, tx?: SqlExecutor): Promise<{ id: string }> {
    return this.inTransaction(tx, async (ex) => {
      const inserted = await ex.execute(sql`
        INSERT INTO ledger_accounts (entity_id, code, name, kind, owner_type, owner_id)
        VALUES (${input.entityId}, ${input.code}, ${input.name}, ${input.kind},
                ${input.ownerType}, ${input.ownerId})
        ON CONFLICT (entity_id, code, owner_type, owner_id) DO NOTHING
        RETURNING id
      `);
      const created = inserted.rows[0]?.['id'] as string | undefined;
      if (created) return { id: created };
      const existing = await ex.execute(sql`
        SELECT id, kind FROM ledger_accounts
        WHERE entity_id = ${input.entityId} AND code = ${input.code}
          AND owner_type = ${input.ownerType} AND owner_id IS NOT DISTINCT FROM ${input.ownerId}::uuid
      `);
      const row = existing.rows[0];
      if (!row) throw new Error('ledger account neither inserted nor found');
      if (row['kind'] !== input.kind)
        throw new ConflictException({ error: 'account_kind_differs' });
      return { id: row['id'] as string };
    });
  }

  async findAccount(
    input: Pick<OpenAccount, 'entityId' | 'code' | 'ownerType' | 'ownerId'>,
    tx?: SqlExecutor,
  ): Promise<{ id: string } | null> {
    const found = await (tx ?? this.db).execute(sql`
      SELECT id FROM ledger_accounts
      WHERE entity_id = ${input.entityId} AND code = ${input.code}
        AND owner_type = ${input.ownerType} AND owner_id IS NOT DISTINCT FROM ${input.ownerId}::uuid
    `);
    const id = found.rows[0]?.['id'] as string | undefined;
    return id ? { id } : null;
  }

  // async: a validation error must reject the promise, never throw synchronously.
  async postJournal(actor: Actor, input: PostJournal, tx?: SqlExecutor): Promise<PostedJournal> {
    validate(input);
    return this.inTransaction(tx, (ex) => this.post(ex, actor, input, null));
  }

  async reverseJournal(
    actor: Actor,
    journalEntryId: string,
    input: { idempotencyKey: string; reason: string },
    tx?: SqlExecutor,
  ): Promise<PostedJournal> {
    if (input.reason.trim().length < 3) throw invalid('reason_required');
    return this.inTransaction(tx, async (ex) => {
      const original = await this.load(ex, journalEntryId);
      if (!original) throw new NotFoundException({ error: 'journal_not_found' });
      if (original.reversesJournalEntryId !== null) {
        throw new ConflictException({ error: 'cannot_reverse_a_reversal' });
      }
      // A retry of this very reversal returns it; the key used for anything else is refused.
      const earlier = await this.findByKey(ex, input.idempotencyKey);
      if (earlier) {
        const journal = await this.load(ex, earlier.id);
        if (journal?.reversesJournalEntryId === original.id) return { ...journal, replayed: true };
        throw new ConflictException({ error: 'idempotency_key_reused' });
      }
      const already = await ex.execute(sql`
        SELECT id FROM journal_entries WHERE reverses_journal_entry_id = ${original.id}
      `);
      if (already.rows.length > 0) throw new ConflictException({ error: 'already_reversed' });

      const reversal: PostJournal = {
        entityId: original.entityId,
        eventType: REVERSAL_EVENT,
        occurredAt: new Date(),
        idempotencyKey: input.idempotencyKey,
        caseId: original.caseId,
        creditApplicationId: original.creditApplicationId,
        reason: input.reason.trim(),
        // Every line to the other side: the balances return exactly to where they were.
        lines: original.lines.map((l): JournalLine => ({
          accountId: l.accountId,
          direction: l.direction === 'debit' ? 'credit' : 'debit',
          amountRial: l.amountRial,
        })),
      };
      validate(reversal);
      let posted: PostedJournal;
      try {
        posted = await this.post(ex, actor, reversal, original.id);
      } catch (error) {
        // Another reversal of the same document committed in the meantime.
        if (violates(error, 'journal_entries_reverses_key')) {
          throw new ConflictException({ error: 'already_reversed' });
        }
        throw error;
      }
      if (!posted.replayed) {
        await this.audit.record(
          {
            actor,
            action: 'ledger.journal_reversed',
            entityType: 'journal_entry',
            entityId: original.id,
            after: { reversalJournalEntryId: posted.id },
            reason: reversal.reason ?? null,
          },
          ex,
        );
      }
      return posted;
    });
  }

  private async post(
    ex: SqlExecutor,
    actor: Actor,
    input: PostJournal,
    reversesJournalEntryId: string | null,
  ): Promise<PostedJournal> {
    const hash = requestHash(input, reversesJournalEntryId);
    const replay = async (): Promise<PostedJournal | null> => {
      const existing = await this.findByKey(ex, input.idempotencyKey);
      if (!existing) return null;
      if (existing.request_hash !== hash) {
        throw new ConflictException({ error: 'idempotency_key_reused' });
      }
      const journal = await this.load(ex, existing.id);
      return journal ? { ...journal, replayed: true } : null;
    };
    const earlier = await replay();
    if (earlier) return earlier;

    // Lock the accounts, always in the same order, so two postings on the same accounts
    // wait for each other instead of deadlocking.
    const accountIds = [...new Set(input.lines.map((l) => l.accountId))].sort();
    const accounts = await ex.execute(sql`
      SELECT id, entity_id FROM ledger_accounts
      WHERE id = ANY (${sql.param(accountIds)}::uuid[])
      ORDER BY id
      FOR UPDATE
    `);
    if (accounts.rows.length !== accountIds.length) throw invalid('unknown_account');
    if (accounts.rows.some((a) => a['entity_id'] !== input.entityId)) {
      throw invalid('account_of_another_entity');
    }

    const inserted = await ex.execute(sql`
      INSERT INTO journal_entries (
        entity_id, event_type, occurred_at, case_id, credit_application_id,
        idempotency_key, request_hash, reverses_journal_entry_id, created_by, reason
      ) VALUES (
        ${input.entityId}, ${input.eventType}, ${input.occurredAt}, ${input.caseId ?? null},
        ${input.creditApplicationId ?? null}, ${input.idempotencyKey}, ${hash},
        ${reversesJournalEntryId}, ${actor.accountId}, ${input.reason ?? null}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `);
    const journalId = inserted.rows[0]?.['id'] as string | undefined;
    if (!journalId) {
      // A concurrent posting with the same key committed first.
      const concurrent = await replay();
      if (concurrent) return concurrent;
      throw new Error('journal entry neither inserted nor found');
    }

    const values: SQL[] = input.lines.map(
      (l) =>
        sql`(${journalId}, ${l.accountId}, ${l.direction}, ${l.amountRial.toString()}::bigint)`,
    );
    await ex.execute(sql`
      INSERT INTO ledger_entries (journal_entry_id, account_id, direction, amount_rial)
      VALUES ${sql.join(values, sql`, `)}
    `);
    await this.outbox.publish(
      {
        type: 'ledger.journal_posted',
        aggregateType: 'journal_entry',
        aggregateId: journalId,
        payload: {
          journalEntryId: journalId,
          entityId: input.entityId,
          eventType: input.eventType,
          reversesJournalEntryId,
        },
      },
      ex,
    );
    const journal = await this.load(ex, journalId);
    if (!journal) throw new Error('posted journal entry not found');
    return journal;
  }

  private async findByKey(ex: SqlExecutor, key: string): Promise<JournalRow | null> {
    const found = await ex.execute(sql`
      SELECT id, request_hash FROM journal_entries WHERE idempotency_key = ${key}
    `);
    return (found.rows[0] as JournalRow | undefined) ?? null;
  }

  private async load(ex: SqlExecutor, id: string): Promise<PostedJournal | null> {
    if (!UUID.test(id)) return null;
    const journals = await ex.execute(sql`
      SELECT id, entity_id, event_type, idempotency_key, request_hash, case_id,
             credit_application_id, reverses_journal_entry_id, reason, created_by,
             to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM journal_entries WHERE id = ${id}
    `);
    const j = journals.rows[0] as JournalRow | undefined;
    if (!j) return null;
    const lines = await ex.execute(sql`
      SELECT id, account_id, direction, amount_rial::text AS amount_rial
      FROM ledger_entries WHERE journal_entry_id = ${id}
      ORDER BY id
    `);
    return {
      id: j.id,
      entityId: j.entity_id,
      eventType: j.event_type,
      occurredAt: new Date(j.occurred_at),
      idempotencyKey: j.idempotency_key,
      caseId: j.case_id,
      creditApplicationId: j.credit_application_id,
      reversesJournalEntryId: j.reverses_journal_entry_id,
      reason: j.reason,
      createdBy: j.created_by,
      createdAt: new Date(j.created_at),
      lines: (lines.rows as LineRow[]).map((l): PostedLine => ({
        id: l.id,
        accountId: l.account_id,
        direction: l.direction,
        amountRial: BigInt(l.amount_rial),
      })),
      replayed: false,
    };
  }

  /** A document with its entries, or null. */
  getJournal(id: string): Promise<PostedJournal | null> {
    return this.load(this.db, id);
  }

  async balanceOf(accountId: string, at?: Date, tx?: SqlExecutor): Promise<AccountBalance> {
    const ex = tx ?? this.db;
    const result = await ex.execute(sql`
      SELECT coalesce(sum(amount_rial) FILTER (WHERE direction = 'debit'), 0)::text AS debit,
             coalesce(sum(amount_rial) FILTER (WHERE direction = 'credit'), 0)::text AS credit
      FROM ledger_entries
      WHERE account_id = ${accountId}
        ${at === undefined ? sql`` : sql`AND created_at <= ${at}`}
    `);
    const row = result.rows[0] ?? {};
    const debitRial = BigInt((row['debit'] as string | undefined) ?? '0');
    const creditRial = BigInt((row['credit'] as string | undefined) ?? '0');
    return { accountId, debitRial, creditRial, netDebitRial: debitRial - creditRial };
  }

  async totalsOfCode(code: string, tx?: SqlExecutor): Promise<CodeTotal[]> {
    const ex = tx ?? this.db;
    const result = await ex.execute(sql`
      SELECT a.entity_id, count(DISTINCT a.id)::int AS accounts,
             coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'debit'), 0)::text AS debit,
             coalesce(sum(e.amount_rial) FILTER (WHERE e.direction = 'credit'), 0)::text AS credit
      FROM ledger_accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.code = ${code}
      GROUP BY a.entity_id
      ORDER BY a.entity_id
    `);
    return result.rows.map((r) => ({
      entityId: r['entity_id'] as string,
      accounts: Number(r['accounts']),
      debitRial: BigInt(r['debit'] as string),
      creditRial: BigInt(r['credit'] as string),
    }));
  }

  async journalsBetween(
    entityId: string,
    from: Date,
    to: Date,
    tx?: SqlExecutor,
  ): Promise<JournalRead[]> {
    const ex = tx ?? this.db;
    const rows = await ex.execute(sql`
      SELECT j.id, j.event_type, j.occurred_at, j.reverses_journal_entry_id,
             a.code, a.owner_type, a.owner_id, e.direction, e.amount_rial::text AS amount
      FROM journal_entries j
      JOIN ledger_entries e ON e.journal_entry_id = j.id
      JOIN ledger_accounts a ON a.id = e.account_id
      WHERE j.entity_id = ${entityId} AND j.occurred_at >= ${from} AND j.occurred_at < ${to}
      ORDER BY j.occurred_at, j.id, e.direction DESC, a.code, e.id
    `);
    type Line = JournalRead['lines'][number];
    const docs = new Map<string, Omit<JournalRead, 'lines'> & { lines: Line[] }>();
    for (const r of rows.rows) {
      const id = r['id'] as string;
      let doc = docs.get(id);
      if (!doc) {
        doc = {
          id,
          eventType: r['event_type'] as string,
          occurredAt: new Date(r['occurred_at'] as string),
          reversesJournalEntryId: (r['reverses_journal_entry_id'] as string | null) ?? null,
          lines: [],
        };
        docs.set(id, doc);
      }
      doc.lines.push({
        accountCode: r['code'] as string,
        ownerType: r['owner_type'] as AccountOwnerType,
        ownerId: (r['owner_id'] as string | null) ?? null,
        direction: r['direction'] as Direction,
        amountRial: BigInt(r['amount'] as string),
      });
    }
    // A Map keeps insertion order: the query's, oldest first.
    const out: JournalRead[] = [...docs.values()];
    return out;
  }
}
