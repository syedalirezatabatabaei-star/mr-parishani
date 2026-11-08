import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type Actor, type SqlExecutor } from '../../common/audit/audit.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import {
  LEDGER,
  type AccountKind,
  type JournalLine,
  type LedgerPort,
} from '../../common/ledger/ledger.port';
import type {
  ActiveRecipient,
  OperationResult,
  PurseScope,
  PurseSummary,
  ReservationState,
  WalletPort,
} from '../../common/wallet/wallet.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORIZATION = /^[A-Za-z0-9_.:-]{1,100}$/;
const FIELD = /^[a-z][a-z0-9_]{1,62}$/;
const DEFAULT_ENTITY = 'aramesh';

type Kind =
  | 'approve'
  | 'charge'
  | 'reserve'
  | 'cancel_reservation'
  | 'register_service'
  | 'finalize'
  | 'cancel_unused'
  | 'hold'
  | 'release'
  | 'reversal';

/** Operations that post a document and may be reversed by reverseOperation(). */
const REVERSIBLE: ReadonlySet<Kind> = new Set([
  'reserve',
  'cancel_reservation',
  'register_service',
  'finalize',
  // Task 4-8 (owner ج): a cancellation of the unused balance, while the purse is open.
  'cancel_unused',
]);

/** ADR-036 (task 4-8): what Aramesh owes the borrower back of an unused down payment. */
const REFUND_PAYABLE = {
  code: 'downpayment.refund_payable',
  kind: 'liability',
  name: 'استرداد پیش‌پرداخت به وام‌گیرنده',
} as const;

/** The purse's own accounts (doc 02 §3), per case: owner_type `purse`. */
const PURSE_ACCOUNTS = {
  approved: { code: 'purse.approved', kind: 'memo', name: 'کیف اعتبار — سقف مصوب' },
  available: { code: 'purse.available', kind: 'memo', name: 'کیف اعتبار — قابل مصرف' },
  reserved: { code: 'purse.reserved', kind: 'memo', name: 'کیف اعتبار — رزرو' },
  consumedPending: {
    code: 'purse.consumed_pending',
    kind: 'memo',
    name: 'کیف اعتبار — در انتظار قطعی',
  },
  debt: { code: 'borrower.debt', kind: 'asset', name: 'طلب از وام‌گیرنده' },
} as const satisfies Record<string, { code: string; kind: AccountKind; name: string }>;
type PurseAccounts = Record<keyof typeof PURSE_ACCOUNTS, string>;

interface PurseRow extends Record<string, unknown> {
  id: string;
  entity_id: string;
  case_id: string;
  credit_application_id: string | null;
  borrower_person_id: string;
  approved_amount_rial: string;
  /** ADR-034: the down payment the purse also holds; 0 for phase 1's purses. */
  down_payment_rial: string;
  center_node_id: string;
  doctor_node_id: string;
  treatment_field_code: string;
  status: 'approved' | 'funded' | 'closed';
  funded_at: string | null;
}

interface OperationRow extends Record<string, unknown> {
  id: string;
  kind: Kind;
  authorization_id: string | null;
  doctor_node_id: string | null;
  amount_rial: string | null;
  journal_entry_id: string | null;
  reverses_operation_id: string | null;
  idempotency_key: string;
  request_hash: string;
}

interface Operation {
  readonly id: string;
  readonly kind: Kind;
  readonly authorizationId: string | null;
  readonly doctorNodeId: string | null;
  readonly amountRial: bigint;
  readonly journalEntryId: string | null;
}

const bad = (error: string, detail?: Record<string, unknown>) =>
  new BadRequestException({ error, ...detail });
const conflict = (error: string, detail?: Record<string, unknown>) =>
  new ConflictException({ error, ...detail });

function checkAmount(amount: unknown): bigint {
  // Rule 1: a JS number (or anything else) is never an amount.
  if (typeof amount !== 'bigint') throw bad('amount_must_be_bigint_rial');
  if (amount <= 0n) throw bad('amount_must_be_positive');
  return amount;
}

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 180) {
    throw bad('idempotency_key_required');
  }
  return key;
}

function checkAuthorization(id: unknown): string {
  if (typeof id !== 'string' || !AUTHORIZATION.test(id)) throw bad('invalid_authorization_id');
  return id;
}

function checkScope(scope: PurseScope): PurseScope {
  if (!UUID.test(scope.centerNodeId) || !UUID.test(scope.doctorNodeId)) {
    throw bad('invalid_scope');
  }
  if (!FIELD.test(scope.treatmentFieldCode)) throw bad('invalid_scope');
  return scope;
}

const hashOf = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      'utf8',
    )
    .digest('hex');

/** Reservation states from the operations that stand (not reversed, not reversals). */
function reservations(ops: readonly Operation[]): Map<string, ReservationState> {
  const states = new Map<
    string,
    {
      doctorNodeId: string;
      reserved: bigint;
      cancelled: bigint;
      registered: bigint;
      finalized: bigint;
      held: boolean;
    }
  >();
  for (const op of ops) {
    if (op.authorizationId === null) continue;
    let s = states.get(op.authorizationId);
    if (!s) {
      s = {
        doctorNodeId: op.doctorNodeId ?? '',
        reserved: 0n,
        cancelled: 0n,
        registered: 0n,
        finalized: 0n,
        held: false,
      };
      states.set(op.authorizationId, s);
    }
    if (op.kind === 'reserve') {
      s.reserved += op.amountRial;
      s.doctorNodeId = op.doctorNodeId ?? s.doctorNodeId;
    } else if (op.kind === 'cancel_reservation') s.cancelled += op.amountRial;
    else if (op.kind === 'register_service') s.registered += op.amountRial;
    else if (op.kind === 'finalize') s.finalized += op.amountRial;
    else if (op.kind === 'hold') s.held = true;
    else if (op.kind === 'release') s.held = false;
  }
  const out = new Map<string, ReservationState>();
  for (const [authorizationId, s] of states) {
    out.set(authorizationId, {
      authorizationId,
      doctorNodeId: s.doctorNodeId,
      reservedRial: s.reserved,
      openRial: s.reserved - s.cancelled - s.registered,
      pendingRial: s.registered - s.finalized,
      finalizedRial: s.finalized,
      held: s.held,
    });
  }
  return out;
}

interface Context {
  readonly ex: SqlExecutor;
  readonly purse: PurseRow;
  /** The purse's scope now: its newest version (task 4-8), else the purse row's. */
  readonly scope: PurseScope;
  readonly accounts: PurseAccounts;
  /** Operations that stand, in order. */
  readonly ops: readonly Operation[];
}

interface Plan {
  readonly kind: Kind;
  readonly authorizationId?: string | null;
  readonly doctorNodeId?: string | null;
  readonly amountRial?: bigint | null;
  /** The document to post, or null (hold, release). */
  readonly lines: readonly JournalLine[] | null;
  readonly reason?: string | null;
  readonly reversesOperationId?: string | null;
  /** For a reversal: the journal to reverse instead of posting `lines`. */
  readonly reverseJournalId?: string | null;
  readonly newStatus?: 'funded' | 'closed' | null;
}

/**
 * The credit purse (task 1-2, doc 02 §3–4, ADR-018). Each operation, in one transaction:
 * lock the purse row, compute balances from the ledger (rule 4), check the hard rules of
 * doc 02 §4 in code, post the document through the LEDGER port in the same transaction,
 * log the operation and publish its event; then check the rules again on the result, so
 * a violation rolls everything back. No operation ever moves purse money to a bank
 * account: there is no cash withdrawal from a purse.
 */
@Injectable()
export class WalletService implements WalletPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  private inTransaction<T>(tx: SqlExecutor | undefined, fn: (ex: SqlExecutor) => Promise<T>) {
    return tx ? fn(tx) : this.db.transaction((own) => fn(own));
  }

  // --- operations ---------------------------------------------------------------------

  async approveCredit(
    actor: Actor,
    input: Parameters<WalletPort['approveCredit']>[1],
    tx?: SqlExecutor,
  ): Promise<OperationResult> {
    const key = checkKey(input.idempotencyKey);
    const amount = checkAmount(input.amountRial);
    const scope = checkScope(input.scope);
    if (!UUID.test(input.caseId) || !UUID.test(input.borrowerPersonId)) throw bad('invalid_case');
    const entityId = input.entityId ?? DEFAULT_ENTITY;
    // ADR-034 (task 4-5, change 1 of 4): the down payment held by Aramesh enters the purse
    // with the approval. Without it, the lines and the request hash are phase 1's.
    const down = input.downPayment;
    if (down !== undefined) {
      if (typeof down.amountRial !== 'bigint' || down.amountRial < 0n) {
        throw bad('amount_must_be_bigint_rial');
      }
      if (!UUID.test(down.heldAccountId)) throw bad('invalid_down_payment_account');
    }
    const downRial = down?.amountRial ?? 0n;
    const hash = hashOf({ op: 'approve', ...input, entityId });

    return this.inTransaction(tx, async (ex) => {
      const earlier = await this.replay(ex, key, hash);
      if (earlier) return earlier;
      const created = await ex.execute(sql`
        INSERT INTO credit_purses (
          entity_id, case_id, credit_application_id, borrower_person_id, approved_amount_rial,
          down_payment_rial, center_node_id, doctor_node_id, treatment_field_code
        ) VALUES (
          ${entityId}, ${input.caseId}, ${input.creditApplicationId ?? null},
          ${input.borrowerPersonId}, ${amount.toString()}::bigint, ${downRial.toString()}::bigint,
          ${scope.centerNodeId}, ${scope.doctorNodeId}, ${scope.treatmentFieldCode}
        )
        -- One purse per credit application, or per case without one (migration 0035).
        ON CONFLICT DO NOTHING
        RETURNING id
      `);
      const purseId = created.rows[0]?.['id'] as string | undefined;
      if (!purseId) throw conflict('purse_exists_for_case');
      const ctx = await this.context(ex, purseId);
      return this.apply(actor, ctx, key, hash, {
        kind: 'approve',
        amountRial: amount,
        lines:
          downRial > 0n && down
            ? [
                { accountId: ctx.accounts.debt, direction: 'debit', amountRial: amount },
                { accountId: down.heldAccountId, direction: 'debit', amountRial: downRial },
                {
                  accountId: ctx.accounts.approved,
                  direction: 'credit',
                  amountRial: amount + downRial,
                },
              ]
            : [
                { accountId: ctx.accounts.debt, direction: 'debit', amountRial: amount },
                { accountId: ctx.accounts.approved, direction: 'credit', amountRial: amount },
              ],
      });
    });
  }

  async charge(actor: Actor, purseId: string, input: { idempotencyKey: string }, tx?: SqlExecutor) {
    return this.operate(actor, purseId, input.idempotencyKey, { op: 'charge' }, tx, (ctx) => {
      if (ctx.purse.status !== 'approved' || ctx.ops.some((o) => o.kind === 'charge')) {
        throw conflict('already_charged');
      }
      // Once, for the whole approved amount (task 1-2 decision), and the down payment the
      // purse holds (ADR-034, change 2 of 4).
      // TODO(decision): partial or staged charges; doc 02 mentions none.
      const amount = BigInt(ctx.purse.approved_amount_rial) + BigInt(ctx.purse.down_payment_rial);
      return {
        kind: 'charge',
        amountRial: amount,
        newStatus: 'funded',
        lines: [
          { accountId: ctx.accounts.approved, direction: 'debit', amountRial: amount },
          { accountId: ctx.accounts.available, direction: 'credit', amountRial: amount },
        ],
      };
    });
  }

  async reserve(
    actor: Actor,
    purseId: string,
    input: Parameters<WalletPort['reserve']>[2],
    tx?: SqlExecutor,
  ) {
    const authorizationId = checkAuthorization(input.authorizationId);
    const amount = checkAmount(input.amountRial);
    const service = checkScope(input.service);
    return this.operate(
      actor,
      purseId,
      input.idempotencyKey,
      { op: 'reserve', authorizationId, amount, service },
      tx,
      async (ctx) => {
        this.requireFunded(ctx);
        // Hard rule: only the center, doctor and treatment field of the case.
        if (
          service.centerNodeId !== ctx.scope.centerNodeId ||
          service.doctorNodeId !== ctx.scope.doctorNodeId ||
          service.treatmentFieldCode !== ctx.scope.treatmentFieldCode
        ) {
          throw bad('service_outside_purse_scope');
        }
        if (reservations(ctx.ops).has(authorizationId))
          throw conflict('authorization_already_reserved');
        const available = await this.chainBalance(ctx, 'available');
        if (amount > available) {
          throw bad('insufficient_available', { availableRial: available.toString() });
        }
        return {
          kind: 'reserve',
          authorizationId,
          doctorNodeId: service.doctorNodeId,
          amountRial: amount,
          lines: [
            { accountId: ctx.accounts.available, direction: 'debit', amountRial: amount },
            { accountId: ctx.accounts.reserved, direction: 'credit', amountRial: amount },
          ],
        };
      },
    );
  }

  async cancelReservation(
    actor: Actor,
    purseId: string,
    input: Parameters<WalletPort['cancelReservation']>[2],
    tx?: SqlExecutor,
  ) {
    const authorizationId = checkAuthorization(input.authorizationId);
    const amount = checkAmount(input.amountRial);
    return this.operate(
      actor,
      purseId,
      input.idempotencyKey,
      { op: 'cancel_reservation', authorizationId, amount },
      tx,
      (ctx) => {
        const state = this.reservation(ctx, authorizationId);
        if (amount > state.openRial) throw bad('exceeds_open_reservation');
        return {
          kind: 'cancel_reservation',
          authorizationId,
          amountRial: amount,
          lines: [
            { accountId: ctx.accounts.reserved, direction: 'debit', amountRial: amount },
            { accountId: ctx.accounts.available, direction: 'credit', amountRial: amount },
          ],
        };
      },
    );
  }

  async registerService(
    actor: Actor,
    purseId: string,
    input: Parameters<WalletPort['registerService']>[2],
    tx?: SqlExecutor,
  ) {
    const authorizationId = checkAuthorization(input.authorizationId);
    const amount = checkAmount(input.amountRial);
    return this.operate(
      actor,
      purseId,
      input.idempotencyKey,
      { op: 'register_service', authorizationId, amount },
      tx,
      (ctx) => {
        this.requireFunded(ctx);
        const state = this.reservation(ctx, authorizationId);
        if (amount > state.openRial) throw bad('exceeds_open_reservation');
        return {
          kind: 'register_service',
          authorizationId,
          amountRial: amount,
          lines: [
            { accountId: ctx.accounts.reserved, direction: 'debit', amountRial: amount },
            { accountId: ctx.accounts.consumedPending, direction: 'credit', amountRial: amount },
          ],
        };
      },
    );
  }

  async finalize(
    actor: Actor,
    purseId: string,
    input: Parameters<WalletPort['finalize']>[2],
    tx?: SqlExecutor,
  ) {
    const authorizationId = checkAuthorization(input.authorizationId);
    const amount = checkAmount(input.amountRial);
    return this.operate(
      actor,
      purseId,
      input.idempotencyKey,
      { op: 'finalize', authorizationId, amount },
      tx,
      async (ctx) => {
        const state = this.reservation(ctx, authorizationId);
        if (state.held) throw conflict('consumption_on_hold');
        if (amount > state.pendingRial) throw bad('exceeds_pending_consumption');
        const payable = await this.ledger.openAccount(
          {
            entityId: ctx.purse.entity_id,
            code: 'doctor.payable',
            name: 'بدهی به پزشک',
            kind: 'liability',
            ownerType: 'doctor',
            ownerId: state.doctorNodeId,
          },
          ctx.ex,
        );
        return {
          kind: 'finalize',
          authorizationId,
          doctorNodeId: state.doctorNodeId,
          amountRial: amount,
          lines: [
            { accountId: ctx.accounts.consumedPending, direction: 'debit', amountRial: amount },
            { accountId: payable.id, direction: 'credit', amountRial: amount },
          ],
        };
      },
    );
  }

  async hold(
    actor: Actor,
    purseId: string,
    input: Parameters<WalletPort['hold']>[2],
    tx?: SqlExecutor,
  ) {
    return this.holdOrRelease(actor, purseId, input, 'hold', tx);
  }

  async release(
    actor: Actor,
    purseId: string,
    input: Parameters<WalletPort['release']>[2],
    tx?: SqlExecutor,
  ) {
    return this.holdOrRelease(actor, purseId, input, 'release', tx);
  }

  private async holdOrRelease(
    actor: Actor,
    purseId: string,
    input: { idempotencyKey: string; authorizationId: string; reason: string },
    kind: 'hold' | 'release',
    tx?: SqlExecutor,
  ) {
    const authorizationId = checkAuthorization(input.authorizationId);
    if (input.reason.trim().length < 3) throw bad('reason_required');
    return this.operate(
      actor,
      purseId,
      input.idempotencyKey,
      { op: kind, authorizationId, reason: input.reason },
      tx,
      (ctx) => {
        const state = this.reservation(ctx, authorizationId);
        if (kind === 'hold' && (state.held || state.pendingRial === 0n)) {
          throw conflict(state.held ? 'already_on_hold' : 'nothing_pending_to_hold');
        }
        if (kind === 'release' && !state.held) throw conflict('not_on_hold');
        return { kind, authorizationId, lines: null, reason: input.reason.trim() };
      },
    );
  }

  /**
   * Cancels what is unused (doc 02 §6; task 4-8, owner پ۱۵: the same operation, with an
   * amount). Unused is split by ADR-034's order of use (the down payment first): the loan's
   * unused part is cancelled first (owner پ۱) and credits borrower.debt; the down
   * payment's goes to downpayment.refund_payable, to be refunded (ADR-036), never off the
   * debt (finding ی۱: phase 1 credited it all to the debt). Without an amount, everything
   * available, as phase 1 did; for a purse without a down payment, the same document.
   */
  async cancelUnused(
    actor: Actor,
    purseId: string,
    input: { idempotencyKey: string; reason: string; amountRial?: bigint },
    tx?: SqlExecutor,
  ) {
    if (input.reason.trim().length < 3) throw bad('reason_required');
    const asked = input.amountRial === undefined ? null : checkAmount(input.amountRial);
    return this.operate(
      actor,
      purseId,
      input.idempotencyKey,
      asked === null
        ? { op: 'cancel_unused', reason: input.reason }
        : { op: 'cancel_unused', reason: input.reason, amountRial: asked },
      tx,
      async (ctx) => {
        this.requireFunded(ctx);
        const unused = await this.unused(ctx);
        const available = unused.loanRial + unused.downPaymentRial;
        if (available === 0n) throw conflict('nothing_available');
        const amount = asked ?? available;
        if (amount > available) {
          throw conflict('exceeds_unused', { unusedRial: available.toString() });
        }
        const loan = amount < unused.loanRial ? amount : unused.loanRial;
        const down = amount - loan;
        // The purse closes once nothing is available, reserved or waiting to be finalized.
        const open = [...reservations(ctx.ops).values()].some(
          (r) => r.openRial > 0n || r.pendingRial > 0n,
        );
        const lines: JournalLine[] = [
          { accountId: ctx.accounts.available, direction: 'debit', amountRial: amount },
        ];
        if (loan > 0n)
          lines.push({ accountId: ctx.accounts.debt, direction: 'credit', amountRial: loan });
        if (down > 0n) {
          const refund = await this.ledger.openAccount(
            {
              entityId: ctx.purse.entity_id,
              ...REFUND_PAYABLE,
              ownerType: 'borrower',
              ownerId: ctx.purse.borrower_person_id,
            },
            ctx.ex,
          );
          lines.push({ accountId: refund.id, direction: 'credit', amountRial: down });
        }
        return {
          kind: 'cancel_unused',
          amountRial: amount,
          reason: input.reason.trim(),
          newStatus: open || amount < available ? null : 'closed',
          lines,
        };
      },
    );
  }

  /**
   * Task 5-2b (ADR-038): what an accepted dispute returned to a closed purse, taken off
   * again; the purse stays closed. Only added: cancelUnused, its funded rule and the
   * invariants are untouched. The same kind of operation as cancelUnused (cancel_unused), so
   * the down payments' reconciliation (4-6b) counts it the same way.
   */
  async scopeOf(
    purseId: string,
    tx?: SqlExecutor,
  ): Promise<{ readonly status: string; readonly scope: PurseScope } | null> {
    if (!UUID.test(purseId)) return null;
    // The same choice as context(): the latest scope version, else the purse's first scope.
    const rows = await (tx ?? this.db).execute(sql`
      SELECT p.status,
             coalesce(v.center_node_id, p.center_node_id) AS center_node_id,
             coalesce(v.doctor_node_id, p.doctor_node_id) AS doctor_node_id,
             coalesce(v.treatment_field_code, p.treatment_field_code) AS treatment_field_code
      FROM credit_purses p
      LEFT JOIN LATERAL (
        SELECT center_node_id, doctor_node_id, treatment_field_code FROM purse_scope_versions
        WHERE purse_id = p.id ORDER BY created_at DESC, id DESC LIMIT 1
      ) v ON true
      WHERE p.id = ${purseId}
    `);
    const row = rows.rows[0];
    if (!row) return null;
    return {
      status: row['status'] as string,
      scope: {
        centerNodeId: row['center_node_id'] as string,
        doctorNodeId: row['doctor_node_id'] as string,
        treatmentFieldCode: row['treatment_field_code'] as string,
      },
    };
  }

  async scheduleOfPurse(purseId: string, tx?: SqlExecutor): Promise<string | null> {
    if (!UUID.test(purseId)) return null;
    const rows = await (tx ?? this.db).execute(sql`
      SELECT schedule_id FROM funding_requests WHERE purse_id = ${purseId} AND status = 'approved'
    `);
    return (rows.rows[0]?.['schedule_id'] as string | null | undefined) ?? null;
  }

  async returnAfterClose(
    actor: Actor,
    purseId: string,
    input: { idempotencyKey: string; reason: string; amountRial: bigint },
    tx?: SqlExecutor,
  ) {
    if (input.reason.trim().length < 3) throw bad('reason_required');
    const amount = checkAmount(input.amountRial);
    return this.operate(
      actor,
      purseId,
      input.idempotencyKey,
      { op: 'return_after_close', reason: input.reason, amountRial: amount },
      tx,
      async (ctx) => {
        if (ctx.purse.status !== 'closed') {
          throw conflict('purse_not_closed', { status: ctx.purse.status });
        }
        const unused = await this.unused(ctx);
        // All of what came back, and nothing else: available is exactly the amount.
        if (unused.loanRial + unused.downPaymentRial !== amount) {
          throw conflict('return_differs', {
            availableRial: (unused.loanRial + unused.downPaymentRial).toString(),
          });
        }
        const lines: JournalLine[] = [
          { accountId: ctx.accounts.available, direction: 'debit', amountRial: amount },
        ];
        if (unused.loanRial > 0n) {
          lines.push({
            accountId: ctx.accounts.debt,
            direction: 'credit',
            amountRial: unused.loanRial,
          });
        }
        if (unused.downPaymentRial > 0n) {
          const refund = await this.ledger.openAccount(
            {
              entityId: ctx.purse.entity_id,
              ...REFUND_PAYABLE,
              ownerType: 'borrower',
              ownerId: ctx.purse.borrower_person_id,
            },
            ctx.ex,
          );
          lines.push({
            accountId: refund.id,
            direction: 'credit',
            amountRial: unused.downPaymentRial,
          });
        }
        return {
          kind: 'cancel_unused',
          amountRial: amount,
          reason: input.reason.trim(),
          newStatus: null,
          lines,
        };
      },
    );
  }

  /**
   * A new doctor for the purse (doc 12 §7; task 4-8, part 2): a new version of its scope; the
   * purse row and its guard stay. Nothing moves in the ledger: the balance is the same
   * (doc 12 §9 test 12). Refused while anything is reserved or waiting to be final: the
   * service module cancels open authorizations first, in the same transaction.
   */
  async changeScope(
    actor: Actor,
    purseId: string,
    input: { idempotencyKey: string; scope: PurseScope; reason: string },
    tx?: SqlExecutor,
  ): Promise<{ versionId: string; replayed: boolean }> {
    const key = checkKey(input.idempotencyKey);
    const scope = checkScope(input.scope);
    if (input.reason.trim().length < 3) throw bad('reason_required');
    if (!UUID.test(purseId)) throw new NotFoundException({ error: 'purse_not_found' });
    return this.inTransaction(tx, async (ex) => {
      const locked = await ex.execute(
        sql`SELECT id FROM credit_purses WHERE id = ${purseId} FOR UPDATE`,
      );
      if (locked.rows.length === 0) throw new NotFoundException({ error: 'purse_not_found' });
      const earlier = await ex.execute(sql`
        SELECT id, purse_id, doctor_node_id, center_node_id, treatment_field_code
        FROM purse_scope_versions WHERE idempotency_key = ${key}
      `);
      const done = earlier.rows[0];
      if (done) {
        if (
          done['purse_id'] !== purseId ||
          done['doctor_node_id'] !== scope.doctorNodeId ||
          done['center_node_id'] !== scope.centerNodeId ||
          done['treatment_field_code'] !== scope.treatmentFieldCode
        ) {
          throw conflict('idempotency_key_reused');
        }
        return { versionId: done['id'] as string, replayed: true };
      }
      const ctx = await this.context(ex, purseId);
      this.requireFunded(ctx);
      if (scope.treatmentFieldCode !== ctx.scope.treatmentFieldCode) {
        throw conflict('needs_new_credit_decision');
      }
      const open = [...reservations(ctx.ops).values()].some(
        (r) => r.openRial > 0n || r.pendingRial > 0n,
      );
      if (open) throw conflict('open_reservations');
      const made = await ex.execute(sql`
        INSERT INTO purse_scope_versions (
          purse_id, center_node_id, doctor_node_id, treatment_field_code, reason,
          idempotency_key, created_by
        ) VALUES (
          ${purseId}, ${scope.centerNodeId}, ${scope.doctorNodeId}, ${scope.treatmentFieldCode},
          ${input.reason.trim()}, ${key}, ${actor.accountId}
        )
        RETURNING id
      `);
      return { versionId: made.rows[0]?.['id'] as string, replayed: false };
    });
  }

  /**
   * What is unused, by part (ADR-034; task 4-8): the down payment is used first, a
   * cancellation takes the loan first. Both draw from opposite ends, so the split follows
   * from the totals alone: used = held − available − cancelled.
   */
  async purseOfApplication(creditApplicationId: string, tx?: SqlExecutor): Promise<string | null> {
    if (!UUID.test(creditApplicationId)) return null;
    const found = await (tx ?? this.db).execute(
      sql`SELECT id FROM credit_purses WHERE credit_application_id = ${creditApplicationId} LIMIT 1`,
    );
    return (found.rows[0]?.['id'] as string | undefined) ?? null;
  }

  async closeIfSettled(
    actor: Actor,
    purseId: string,
    input: { reason: string },
    tx?: SqlExecutor,
  ): Promise<{ closed: true; already: boolean }> {
    if (!UUID.test(purseId)) throw new NotFoundException({ error: 'purse_not_found' });
    if (input.reason.trim().length < 3) throw bad('reason_required');
    return this.inTransaction(tx, async (ex) => {
      await ex.execute(sql`SELECT id FROM credit_purses WHERE id = ${purseId} FOR UPDATE`);
      const ctx = await this.context(ex, purseId);
      if (ctx.purse.status === 'closed') return { closed: true as const, already: true };
      this.requireFunded(ctx);
      const available = await this.chainBalance(ctx, 'available');
      // Owner س۳: nothing available and nothing reserved. A service already used (registered,
      // awaiting phase 5's doctor.payable) is neither: finalize still takes it on a closed purse.
      const open = [...reservations(ctx.ops).values()].some((r) => r.openRial > 0n);
      if (available !== 0n || open) {
        throw conflict('purse_not_settled', { availableRial: available.toString(), open });
      }
      await ex.execute(sql`
        UPDATE credit_purses SET status = 'closed', closed_at = now() WHERE id = ${purseId}
      `);
      await this.checkInvariants(ex, purseId);
      await this.outbox.publish(
        {
          type: 'wallet.purse_closed',
          aggregateType: 'credit_purse',
          aggregateId: purseId,
          payload: { purseId, caseId: ctx.purse.case_id },
        },
        ex,
      );
      return { closed: true as const, already: false };
    });
  }

  async activeRecipient(purseId: string, tx?: SqlExecutor): Promise<ActiveRecipient | null> {
    if (!UUID.test(purseId)) return null;
    const rows = await (tx ?? this.db).execute(sql`
      SELECT id, recipient_person_id, recipient_mobile, amount_rial::text AS amount_rial,
             decided_at
      FROM credit_transfers
      WHERE purse_id = ${purseId} AND status IN ('approved', 'revoke_requested')
    `);
    const r = rows.rows[0];
    if (!r) return null;
    return {
      transferId: r['id'] as string,
      personId: r['recipient_person_id'] as string,
      mobile: r['recipient_mobile'] as string,
      amountRial: BigInt(r['amount_rial'] as string),
      since: new Date(r['decided_at'] as string),
    };
  }

  async downPaymentRefunds(
    tx?: SqlExecutor,
  ): Promise<{ entityId: string; borrowerPersonId: string; rial: bigint }[]> {
    const rows = await (tx ?? this.db).execute(sql`
      SELECT p.entity_id, p.borrower_person_id,
             sum(CASE r.kind WHEN 'reverse_cancel_unused' THEN -1 ELSE 1 END
                 * (r.result ->> 'downPaymentRial')::bigint)::text AS rial
      FROM purse_operation_requests r
      JOIN credit_purses p ON p.id = r.purse_id
      WHERE r.status = 'approved'
        AND r.kind IN ('cancel_unused', 'reverse_cancel_unused', 'cancel_after_funding')
        AND r.result ? 'downPaymentRial'
      GROUP BY p.entity_id, p.borrower_person_id
    `);
    return rows.rows.map((r) => ({
      entityId: r['entity_id'] as string,
      borrowerPersonId: r['borrower_person_id'] as string,
      rial: BigInt(r['rial'] as string),
    }));
  }

  async unusedOf(
    purseId: string,
    tx?: SqlExecutor,
  ): Promise<{ loanRial: bigint; downPaymentRial: bigint }> {
    if (!UUID.test(purseId)) throw new NotFoundException({ error: 'purse_not_found' });
    return this.inTransaction(tx, async (ex) => this.unused(await this.context(ex, purseId)));
  }

  private async unused(ctx: Context): Promise<{ loanRial: bigint; downPaymentRial: bigint }> {
    const loan = BigInt(ctx.purse.approved_amount_rial);
    const down = BigInt(ctx.purse.down_payment_rial);
    if (ctx.purse.status === 'approved') return { loanRial: 0n, downPaymentRial: 0n };
    const available = await this.chainBalance(ctx, 'available');
    const cancelled = ctx.ops
      .filter((o) => o.kind === 'cancel_unused')
      .reduce((s, o) => s + o.amountRial, 0n);
    const used = loan + down - available - cancelled;
    const usedDown = used < down ? used : down;
    const usedLoan = used - usedDown;
    const loanLeft = loan - usedLoan;
    const cancelledLoan = cancelled < loanLeft ? cancelled : loanLeft;
    const cancelledDown = cancelled - cancelledLoan;
    const result = {
      loanRial: loanLeft - cancelledLoan,
      downPaymentRial: down - usedDown - cancelledDown,
    };
    if (
      result.loanRial < 0n ||
      result.downPaymentRial < 0n ||
      result.loanRial + result.downPaymentRial !== available
    ) {
      throw new Error(`unused split of purse ${ctx.purse.id} does not add up`);
    }
    return result;
  }

  async reverseOperation(
    actor: Actor,
    purseId: string,
    operationId: string,
    input: { idempotencyKey: string; reason: string },
    tx?: SqlExecutor,
  ) {
    if (input.reason.trim().length < 3) throw bad('reason_required');
    return this.operate(
      actor,
      purseId,
      input.idempotencyKey,
      { op: 'reversal', operationId, reason: input.reason },
      tx,
      (ctx) => {
        const target = ctx.ops.find((o) => o.id === operationId);
        if (!target) throw conflict('operation_not_reversible_or_already_reversed');
        // TODO(decision): reversing approval, charge or cancellation changes the purse's
        // lifecycle (funded_at is the installment basis); not supported until decided.
        if (!REVERSIBLE.has(target.kind) || target.journalEntryId === null) {
          throw conflict('operation_not_reversible');
        }
        // A cancellation that closed the purse is final: a closed purse never reopens.
        if (target.kind === 'cancel_unused' && ctx.purse.status !== 'funded') {
          throw conflict('purse_closed', { status: ctx.purse.status });
        }
        return {
          kind: 'reversal',
          authorizationId: target.authorizationId,
          reversesOperationId: target.id,
          reverseJournalId: target.journalEntryId,
          lines: null,
          reason: input.reason.trim(),
        };
      },
    );
  }

  // --- the common path ----------------------------------------------------------------

  private operate(
    actor: Actor,
    purseId: string,
    idempotencyKey: string,
    request: Record<string, unknown>,
    tx: SqlExecutor | undefined,
    plan: (ctx: Context) => Plan | Promise<Plan>,
  ): Promise<OperationResult> {
    const key = checkKey(idempotencyKey);
    if (!UUID.test(purseId))
      return Promise.reject(new NotFoundException({ error: 'purse_not_found' }));
    const hash = hashOf({ ...request, purseId });
    return this.inTransaction(tx, async (ex) => {
      // The lock first: every operation on this purse waits for the one before it.
      const locked = await ex.execute(
        sql`SELECT id FROM credit_purses WHERE id = ${purseId} FOR UPDATE`,
      );
      if (locked.rows.length === 0) throw new NotFoundException({ error: 'purse_not_found' });
      const earlier = await this.replay(ex, key, hash, purseId);
      if (earlier) return earlier;
      const ctx = await this.context(ex, purseId);
      return this.apply(actor, ctx, key, hash, await plan(ctx));
    });
  }

  /** Posts the plan, logs it, moves the state, re-checks the rules, publishes the event. */
  private async apply(
    actor: Actor,
    ctx: Context,
    key: string,
    hash: string,
    plan: Plan,
  ): Promise<OperationResult> {
    const { ex, purse } = ctx;
    let journalId: string | null = null;
    if (plan.reverseJournalId) {
      const reversal = await this.ledger.reverseJournal(
        actor,
        plan.reverseJournalId,
        { idempotencyKey: `wallet:${key}`, reason: plan.reason ?? '' },
        ex,
      );
      journalId = reversal.id;
    } else if (plan.lines) {
      const journal = await this.ledger.postJournal(
        actor,
        {
          entityId: purse.entity_id,
          eventType: `wallet.${plan.kind}`,
          occurredAt: new Date(),
          idempotencyKey: `wallet:${key}`,
          caseId: purse.case_id,
          creditApplicationId: purse.credit_application_id,
          reason: plan.reason ?? null,
          lines: plan.lines,
        },
        ex,
      );
      journalId = journal.id;
    }

    const inserted = await ex.execute(sql`
      INSERT INTO purse_operations (
        purse_id, kind, authorization_id, doctor_node_id, amount_rial, journal_entry_id,
        reverses_operation_id, idempotency_key, request_hash, created_by, reason
      ) VALUES (
        ${purse.id}, ${plan.kind}, ${plan.authorizationId ?? null}, ${plan.doctorNodeId ?? null},
        ${plan.amountRial === undefined || plan.amountRial === null ? null : plan.amountRial.toString()}::bigint,
        ${journalId}, ${plan.reversesOperationId ?? null}, ${key}, ${hash},
        ${actor.accountId}, ${plan.reason ?? null}
      )
      RETURNING id
    `);
    const operationId = inserted.rows[0]?.['id'] as string;

    if (plan.newStatus === 'funded') {
      await ex.execute(sql`
        UPDATE credit_purses SET status = 'funded', funded_at = now() WHERE id = ${purse.id}
      `);
    } else if (plan.newStatus === 'closed') {
      await ex.execute(sql`
        UPDATE credit_purses SET status = 'closed', closed_at = now() WHERE id = ${purse.id}
      `);
    }

    await this.checkInvariants(ex, purse.id);

    await this.outbox.publish(
      {
        type: 'wallet.operation_recorded',
        aggregateType: 'credit_purse',
        aggregateId: purse.id,
        payload: {
          purseId: purse.id,
          caseId: purse.case_id,
          operationId,
          kind: plan.kind,
          authorizationId: plan.authorizationId ?? null,
          amountRial:
            plan.amountRial === undefined || plan.amountRial === null
              ? null
              : plan.amountRial.toString(),
        },
      },
      ex,
    );
    return { purseId: purse.id, operationId, journalEntryId: journalId, replayed: false };
  }

  /**
   * The hard rules of doc 02 §4, checked on the state after the operation; a violation
   * throws and the whole transaction, ledger posting included, rolls back.
   */
  private async checkInvariants(ex: SqlExecutor, purseId: string): Promise<void> {
    const ctx = await this.context(ex, purseId);
    for (const account of ['approved', 'available', 'reserved', 'consumedPending'] as const) {
      if ((await this.chainBalance(ctx, account)) < 0n) {
        throw conflict('purse_balance_would_go_negative', {
          account: PURSE_ACCOUNTS[account].code,
        });
      }
    }
    for (const r of reservations(ctx.ops).values()) {
      if (r.openRial < 0n || r.pendingRial < 0n) throw conflict('reservation_would_go_negative');
    }
    // Total consumption (registered services that stand) never exceeds what the purse
    // holds: the approved amount and the down payment (ADR-034, change 3 of 4).
    const registered = ctx.ops
      .filter((o) => o.kind === 'register_service')
      .reduce((s, o) => s + o.amountRial, 0n);
    if (registered > BigInt(ctx.purse.approved_amount_rial) + BigInt(ctx.purse.down_payment_rial)) {
      throw conflict('consumption_exceeds_approved');
    }
  }

  // --- reading ------------------------------------------------------------------------

  private async context(ex: SqlExecutor, purseId: string): Promise<Context> {
    const purses = await ex.execute(sql`
      SELECT id, entity_id, case_id, credit_application_id, borrower_person_id,
             approved_amount_rial::text,
             down_payment_rial::text, center_node_id, doctor_node_id, treatment_field_code, status,
             to_char(funded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS funded_at
      FROM credit_purses WHERE id = ${purseId}
    `);
    const purse = purses.rows[0] as PurseRow | undefined;
    if (!purse) throw new NotFoundException({ error: 'purse_not_found' });

    const entries = Object.entries(PURSE_ACCOUNTS) as [
      keyof typeof PURSE_ACCOUNTS,
      (typeof PURSE_ACCOUNTS)[keyof typeof PURSE_ACCOUNTS],
    ][];
    const accounts = {} as PurseAccounts;
    for (const [name, def] of entries) {
      accounts[name] = (
        await this.ledger.openAccount(
          { entityId: purse.entity_id, ...def, ownerType: 'purse', ownerId: purse.id },
          ex,
        )
      ).id;
    }

    const rows = await ex.execute(sql`
      SELECT id, kind, authorization_id, doctor_node_id, amount_rial::text, journal_entry_id,
             reverses_operation_id, idempotency_key, request_hash
      FROM purse_operations WHERE purse_id = ${purseId}
      ORDER BY created_at, id
    `);
    const all = rows.rows as OperationRow[];
    const reversed = new Set(all.map((r) => r.reverses_operation_id).filter((id) => id !== null));
    const ops = all
      .filter((r) => r.kind !== 'reversal' && !reversed.has(r.id))
      .map((r): Operation => ({
        id: r.id,
        kind: r.kind,
        authorizationId: r.authorization_id,
        doctorNodeId: r.doctor_node_id,
        amountRial: r.amount_rial === null ? 0n : BigInt(r.amount_rial),
        journalEntryId: r.journal_entry_id,
      }));
    const versions = await ex.execute(sql`
      SELECT center_node_id, doctor_node_id, treatment_field_code FROM purse_scope_versions
      WHERE purse_id = ${purseId} ORDER BY created_at DESC, id DESC LIMIT 1
    `);
    const version = versions.rows[0];
    const scope: PurseScope = version
      ? {
          centerNodeId: version['center_node_id'] as string,
          doctorNodeId: version['doctor_node_id'] as string,
          treatmentFieldCode: version['treatment_field_code'] as string,
        }
      : {
          centerNodeId: purse.center_node_id,
          doctorNodeId: purse.doctor_node_id,
          treatmentFieldCode: purse.treatment_field_code,
        };
    return { ex, purse, scope, accounts, ops };
  }

  /** A purse-chain balance as a positive amount (the chain carries credit balances). */
  private async chainBalance(ctx: Context, account: keyof typeof PURSE_ACCOUNTS): Promise<bigint> {
    const b = await this.ledger.balanceOf(ctx.accounts[account], undefined, ctx.ex);
    return account === 'debt' ? b.netDebitRial : -b.netDebitRial;
  }

  private reservation(ctx: Context, authorizationId: string): ReservationState {
    const state = reservations(ctx.ops).get(authorizationId);
    if (!state || state.reservedRial === 0n)
      throw new NotFoundException({ error: 'reservation_not_found' });
    return state;
  }

  private requireFunded(ctx: Context) {
    if (ctx.purse.status !== 'funded')
      throw conflict('purse_not_funded', { status: ctx.purse.status });
  }

  /** The earlier result for this key, or null; 409 if the key was used for something else. */
  private async replay(
    ex: SqlExecutor,
    key: string,
    hash: string,
    purseId?: string,
  ): Promise<OperationResult | null> {
    const found = await ex.execute(sql`
      SELECT id, purse_id, journal_entry_id, request_hash FROM purse_operations
      WHERE idempotency_key = ${key}
    `);
    const row = found.rows[0];
    if (!row) return null;
    if (row['request_hash'] !== hash || (purseId !== undefined && row['purse_id'] !== purseId)) {
      throw conflict('idempotency_key_reused');
    }
    return {
      purseId: row['purse_id'] as string,
      operationId: row['id'] as string,
      journalEntryId: (row['journal_entry_id'] as string | null) ?? null,
      replayed: true,
    };
  }

  async summary(purseId: string, tx?: SqlExecutor): Promise<PurseSummary> {
    if (!UUID.test(purseId)) throw new NotFoundException({ error: 'purse_not_found' });
    return this.inTransaction(tx, async (ex) => {
      const ctx = await this.context(ex, purseId);
      return {
        id: ctx.purse.id,
        entityId: ctx.purse.entity_id,
        caseId: ctx.purse.case_id,
        status: ctx.purse.status,
        approvedAmountRial: BigInt(ctx.purse.approved_amount_rial),
        // ADR-034, change 4 of 4.
        downPaymentRial: BigInt(ctx.purse.down_payment_rial),
        creditApplicationId: ctx.purse.credit_application_id,
        borrowerPersonId: ctx.purse.borrower_person_id,
        fundedAt: ctx.purse.funded_at ? new Date(ctx.purse.funded_at) : null,
        scope: ctx.scope,
        balances: {
          approvedRial: await this.chainBalance(ctx, 'approved'),
          availableRial: await this.chainBalance(ctx, 'available'),
          reservedRial: await this.chainBalance(ctx, 'reserved'),
          consumedPendingRial: await this.chainBalance(ctx, 'consumedPending'),
          borrowerDebtRial: await this.chainBalance(ctx, 'debt'),
        },
        reservations: [...reservations(ctx.ops).values()],
      };
    });
  }
}
