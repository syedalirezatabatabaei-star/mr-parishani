import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DeliveryStatus,
  DeliveryView,
  InstrumentView,
  MyInstrument,
  PermissionCode,
} from '@sepehr/contracts';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import {
  CREDIT_CONTRACT_FACTS,
  type CreditContractFacts,
  type CreditContractFactsPort,
} from '../../common/credit/credit-contract-facts.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { LEAD_CASES, type LeadCases } from '../../common/lead/lead-cases.port';
import {
  PROFORMA_DIRECTORY,
  type ProformaDirectory,
} from '../../common/proforma/proforma-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import type { CheckedCheque } from '../../common/instrument/delivery-status.port';
import { DATABASE, type Database } from '../../db/database.module';
import { lastFour } from '../../security/blind-index';
import { INSTRUMENT_CRYPTO, INSTRUMENT_NUMBER, type InstrumentCrypto } from './instrument.crypto';
import { instruments, physicalDeliveries, physicalDeliveryItems } from './instrument.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type DeliveryRow = typeof physicalDeliveries.$inferSelect;
type InstrumentRow = typeof instruments.$inferSelect;
type Method = NonNullable<DeliveryRow['method']>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deliveryNotFound = () => new NotFoundException({ error: 'delivery_not_found' });
const instrumentNotFound = () => new NotFoundException({ error: 'instrument_not_found' });
/** A cheque the cheque rule counts (ج۵): checked, and still with the office or the bank. */
const CHECKED_CHEQUE = ['verified', 'held', 'presented', 'cleared'] as const;

/**
 * Physical deliveries and guarantee instruments (task 4-2; doc 12 §3).
 *
 * Case completion expects a delivery of a decided application (the signed contract,
 * cheques, notes, other documents); its owner says how it was sent; case completion
 * receives it, marks each item, registers each cheque or note, confirms a cheque was
 * registered in Sayad by its issuer (no connection to Sayad, version one), checks the
 * delivery (verified, or incomplete with an SMS of what is missing) and archives it, which
 * holds its instruments.
 *
 * An instrument's number is encrypted at once (rule 27) and found by its blind index; it
 * is never shown but by its last four characters, never in the audit trail, an event, a
 * log or an SMS. Its full number is read only with `instrument.view_numbers`, each view in
 * the access log (doc 04 §7).
 */
@Injectable()
export class InstrumentService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CREDIT_CONTRACT_FACTS) private readonly credit: CreditContractFactsPort,
    @Inject(PROFORMA_DIRECTORY) private readonly proformas: ProformaDirectory,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
    @Inject(LEAD_CASES) private readonly leads: LeadCases,
    @Inject(INSTRUMENT_CRYPTO) private readonly crypto: InstrumentCrypto,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  /** Owner 1405/07/27: whether promissory notes are taken (off: never). */
  async options(access: EffectiveAccess): Promise<{ promissoryNotesEnabled: boolean }> {
    this.require(access, 'instrument.manage');
    return { promissoryNotesEnabled: await this.promissoryEnabled() };
  }

  private async promissoryEnabled(): Promise<boolean> {
    return (await this.config.resolve('instrument.promissory_enabled')).value;
  }

  // --- deliveries -------------------------------------------------------------------

  async createDelivery(
    actor: Actor,
    access: EffectiveAccess,
    input: { creditApplicationId: string; items: readonly { kind: string; label: string }[] },
  ): Promise<DeliveryView> {
    this.require(access, 'instrument.manage');
    if (
      input.items.some((i) => i.kind === 'promissory_note') &&
      !(await this.promissoryEnabled())
    ) {
      throw new ConflictException({ error: 'promissory_disabled' });
    }
    const facts = await this.reachable(access, input.creditApplicationId);
    if (facts.status !== 'approved' && facts.status !== 'conditional') {
      throw new ConflictException({ error: 'not_approved', status: facts.status });
    }
    const id = await this.db.transaction(async (tx) => {
      const [made] = await tx
        .insert(physicalDeliveries)
        .values({
          creditApplicationId: facts.creditApplicationId,
          createdBy: actor.accountId ?? '',
        })
        .returning();
      if (!made) throw new Error('delivery insert returned nothing');
      // One by one: items keep the order they were listed in (uuidv7, same timestamp).
      for (const i of input.items) {
        await tx.insert(physicalDeliveryItems).values({
          deliveryId: made.id,
          kind: i.kind as (typeof physicalDeliveryItems.$inferInsert)['kind'],
          label: i.label,
        });
      }
      await this.audit.record(
        {
          actor,
          action: 'instrument.delivery_expected',
          entityType: 'physical_delivery',
          entityId: made.id,
          after: { creditApplicationId: made.creditApplicationId, items: input.items.length },
        },
        tx,
      );
      return made.id;
    });
    return this.deliveryView(await this.deliveryRow(id));
  }

  async deliveries(access: EffectiveAccess, creditApplicationId: string): Promise<DeliveryView[]> {
    this.require(access, 'instrument.read');
    const facts = await this.reachable(access, creditApplicationId);
    const rows = await this.db
      .select()
      .from(physicalDeliveries)
      .where(eq(physicalDeliveries.creditApplicationId, facts.creditApplicationId))
      .orderBy(desc(physicalDeliveries.createdAt));
    return Promise.all(rows.map((r) => this.deliveryView(r)));
  }

  async delivery(access: EffectiveAccess, id: string): Promise<DeliveryView> {
    this.require(access, 'instrument.read');
    return this.deliveryView(await this.staffDelivery(access, id));
  }

  /** Case completion receives it: how it came, who took it, when. */
  async receive(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    input: { method: Method; trackingCode?: string | undefined },
  ) {
    this.require(access, 'instrument.manage');
    const reached = await this.staffDelivery(access, id);
    await this.move(actor, reached.id, ['awaiting_send', 'sent'], 'received', {
      method: input.method,
      trackingCode: input.trackingCode ?? reached.trackingCode,
      receivedBy: actor.accountId,
      receivedAt: new Date(),
    });
    return this.deliveryView(await this.deliveryRow(reached.id));
  }

  async markItem(
    actor: Actor,
    access: EffectiveAccess,
    id: string,
    itemId: string,
    status: 'received' | 'missing',
  ) {
    this.require(access, 'instrument.manage');
    const reached = await this.staffDelivery(access, id);
    if (reached.status !== 'received' && reached.status !== 'incomplete') {
      throw new ConflictException({ error: 'wrong_status', status: reached.status });
    }
    const [item] = await this.db
      .update(physicalDeliveryItems)
      .set({ status })
      .where(
        and(eq(physicalDeliveryItems.id, itemId), eq(physicalDeliveryItems.deliveryId, reached.id)),
      )
      .returning();
    if (!item) throw new NotFoundException({ error: 'delivery_item_not_found' });
    await this.audit.record({
      actor,
      action: 'instrument.delivery_item_marked',
      entityType: 'physical_delivery',
      entityId: reached.id,
      after: { itemId, status },
    });
    return this.deliveryView(await this.deliveryRow(reached.id));
  }

  /**
   * Verified when every item came and every instrument of it was checked; otherwise
   * incomplete, and its owner is told what is missing by SMS (item names only).
   */
  async check(actor: Actor, access: EffectiveAccess, id: string) {
    this.require(access, 'instrument.manage');
    const reached = await this.staffDelivery(access, id);
    const items = await this.itemsOf(reached.id);
    const owned = await this.instrumentsOfDelivery(reached.id);
    const missing = items.filter((i) => i.status !== 'received');
    const unchecked = owned.filter((i) => i.status === 'received');
    const instrumentItems = items.filter(
      (i) => i.kind === 'cheque' || i.kind === 'promissory_note',
    );
    const unregistered = instrumentItems.filter((i) => !owned.some((o) => o.itemId === i.id));
    if (missing.length === 0 && unregistered.length === 0) {
      if (unchecked.length > 0) {
        throw new ConflictException({ error: 'instruments_not_verified', count: unchecked.length });
      }
      await this.move(
        actor,
        reached.id,
        ['received', 'incomplete'],
        'verified',
        {},
        'instrument.delivery_verified',
      );
    } else {
      if (missing.length === 0) {
        throw new ConflictException({
          error: 'instruments_not_registered',
          count: unregistered.length,
        });
      }
      await this.move(
        actor,
        reached.id,
        ['received'],
        'incomplete',
        {},
        'instrument.delivery_incomplete',
      );
    }
    return this.deliveryView(await this.deliveryRow(reached.id));
  }

  async returnDelivery(actor: Actor, access: EffectiveAccess, id: string, reason: string) {
    this.require(access, 'instrument.manage');
    const reached = await this.staffDelivery(access, id);
    await this.move(actor, reached.id, ['sent', 'received', 'incomplete'], 'returned', {
      returnReason: reason,
    });
    return this.deliveryView(await this.deliveryRow(reached.id));
  }

  /** Kept at `location`; its instruments are held. */
  async archive(actor: Actor, access: EffectiveAccess, id: string, location: string) {
    this.require(access, 'instrument.manage');
    const reached = await this.staffDelivery(access, id);
    await this.move(
      actor,
      reached.id,
      ['verified'],
      'archived',
      { archiveLocation: location },
      'instrument.delivery_archived',
      async (tx) => {
        await tx
          .update(instruments)
          .set({ status: 'held' })
          .where(and(eq(instruments.deliveryId, reached.id), eq(instruments.status, 'verified')));
      },
    );
    return this.deliveryView(await this.deliveryRow(reached.id));
  }

  // --- instruments ------------------------------------------------------------------

  async register(
    actor: Actor,
    access: EffectiveAccess,
    deliveryId: string,
    input: {
      itemId: string;
      kind: 'cheque' | 'promissory_note';
      issuer: { role: 'borrower' } | { role: 'guarantor'; guarantorId: string };
      amountRial: bigint;
      dueOn?: string | undefined;
      bankName?: string | undefined;
      number: string;
      notes?: string | undefined;
    },
  ): Promise<InstrumentView> {
    this.require(access, 'instrument.manage');
    if (input.kind === 'promissory_note' && !(await this.promissoryEnabled())) {
      throw new ConflictException({ error: 'promissory_disabled' });
    }
    const delivery = await this.staffDelivery(access, deliveryId);
    if (delivery.status !== 'received' && delivery.status !== 'incomplete') {
      throw new ConflictException({ error: 'wrong_status', status: delivery.status });
    }
    const [item] = await this.db
      .select()
      .from(physicalDeliveryItems)
      .where(
        and(
          eq(physicalDeliveryItems.id, input.itemId),
          eq(physicalDeliveryItems.deliveryId, delivery.id),
        ),
      );
    if (!item || item.kind !== input.kind) {
      throw new BadRequestException({ error: 'item_is_not_that_instrument' });
    }
    const facts = await this.reachable(access, delivery.creditApplicationId);
    let issuerPersonId = facts.borrowerPersonId;
    let guarantorId: string | null = null;
    if (input.issuer.role === 'guarantor') {
      const wanted = input.issuer.guarantorId;
      const g = facts.guarantors.find((x) => x.id === wanted);
      if (!g) throw new BadRequestException({ error: 'unknown_guarantor' });
      issuerPersonId = g.personId;
      guarantorId = g.id;
    }
    const made = await this.db
      .transaction(async (tx) => {
        // ADR-040: while a key rotation is under way the same number may be indexed under an
        // older key, which the unique index does not see. One number of a kind registers at a
        // time (a lock on its index under the ring's lowest key, the same in every process),
        // and it is refused if indexed under any key.
        const { blindIndex } = this.crypto;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
          ${`instrument:${input.kind}:${blindIndex.stableOf('instrument_number', input.number)}`},
          0))`);
        const taken = await tx
          .select({ id: instruments.id })
          .from(instruments)
          .where(
            and(
              eq(instruments.kind, input.kind),
              inArray(instruments.numberBidx, blindIndex.allOf('instrument_number', input.number)),
              isNull(instruments.deletedAt),
            ),
          );
        if (taken.length > 0) throw new ConflictException({ error: 'instrument_exists' });
        const [row] = await tx
          .insert(instruments)
          .values({
            creditApplicationId: delivery.creditApplicationId,
            deliveryId: delivery.id,
            itemId: item.id,
            kind: input.kind,
            issuerPersonId,
            role: input.issuer.role,
            guarantorId,
            amountRial: input.amountRial,
            dueOn: input.dueOn ?? null,
            bankName: input.bankName ?? null,
            // Encrypted and indexed before it is written (rule 27); never kept in clear.
            numberEnc: this.crypto.fieldCrypto.encrypt(input.number, INSTRUMENT_NUMBER),
            numberBidx: this.crypto.blindIndex.of('instrument_number', input.number),
            numberLast4: lastFour(input.number),
            notes: input.notes ?? null,
            createdBy: actor.accountId ?? '',
          })
          .returning();
        if (!row) throw new Error('instrument insert returned nothing');
        await this.audit.record(
          {
            actor,
            action: 'instrument.registered',
            entityType: 'instrument',
            entityId: row.id,
            after: {
              deliveryId: delivery.id,
              kind: row.kind,
              role: row.role,
              amountRial: row.amountRial.toString(),
              numberLast4: row.numberLast4,
            },
          },
          tx,
        );
        return row;
      })
      .catch((error: unknown) => {
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') {
          throw new ConflictException({ error: 'instrument_exists' });
        }
        throw error;
      });
    return this.instrumentView(await this.instrumentRow(made.id));
  }

  /** Sayad: the issuer registered the cheque; case completion confirms it (doc 12 §3). */
  async confirmSayad(actor: Actor, access: EffectiveAccess, id: string) {
    this.require(access, 'instrument.manage');
    const row = await this.staffInstrument(access, id);
    if (row.kind !== 'cheque') throw new ConflictException({ error: 'not_a_cheque' });
    if (row.sayadRegisteredConfirmed) throw new ConflictException({ error: 'already_confirmed' });
    await this.db.transaction(async (tx) => {
      await tx
        .update(instruments)
        .set({
          sayadRegisteredConfirmed: true,
          sayadConfirmedAt: new Date(),
          sayadConfirmedBy: actor.accountId,
        })
        .where(eq(instruments.id, row.id));
      await this.audit.record(
        {
          actor,
          action: 'instrument.sayad_confirmed',
          entityType: 'instrument',
          entityId: row.id,
          after: { numberLast4: row.numberLast4 },
        },
        tx,
      );
    });
    return this.instrumentView(await this.instrumentRow(row.id));
  }

  async verify(actor: Actor, access: EffectiveAccess, id: string) {
    this.require(access, 'instrument.manage');
    const row = await this.staffInstrument(access, id);
    if (row.status !== 'received')
      throw new ConflictException({ error: 'wrong_status', status: row.status });
    if (row.kind === 'cheque' && !row.sayadRegisteredConfirmed) {
      throw new ConflictException({ error: 'sayad_not_confirmed' });
    }
    await this.db.transaction(async (tx) => {
      await tx.update(instruments).set({ status: 'verified' }).where(eq(instruments.id, row.id));
      await this.audit.record(
        {
          actor,
          action: 'instrument.verified',
          entityType: 'instrument',
          entityId: row.id,
          before: { status: row.status },
          after: { status: 'verified' },
        },
        tx,
      );
    });
    return this.instrumentView(await this.instrumentRow(row.id));
  }

  /**
   * Found by its number through the blind index, never by decrypting (rule 27), under every
   * key of the ring: a row still indexed under an older key is found during a rotation
   * (ADR-040).
   */
  async search(access: EffectiveAccess, number: string): Promise<InstrumentView[]> {
    this.require(access, 'instrument.read');
    const indexes = this.crypto.blindIndex.allOf('instrument_number', number);
    const rows = await this.db
      .select()
      .from(instruments)
      .where(and(inArray(instruments.numberBidx, indexes), isNull(instruments.deletedAt)));
    const visible: InstrumentRow[] = [];
    for (const r of rows) {
      if (
        await this.reachable(access, r.creditApplicationId).then(
          () => true,
          () => false,
        )
      ) {
        visible.push(r);
      }
    }
    return visible.map((r) => this.instrumentView(r));
  }

  /** The full number, for whoever may see it, each view logged (doc 04 §7). */
  async number(actor: Actor, access: EffectiveAccess, id: string) {
    this.require(access, 'instrument.view_numbers');
    const row = await this.staffInstrument(access, id);
    await this.audit.recordView(actor, 'instrument_number', row.id);
    return { number: this.crypto.fieldCrypto.decrypt(row.numberEnc, INSTRUMENT_NUMBER) };
  }

  /** DELIVERY_STATUS (task 4-3): a delivery verified, with its instruments checked. */
  async isVerified(creditApplicationId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(physicalDeliveries)
      .where(
        and(
          eq(physicalDeliveries.creditApplicationId, creditApplicationId),
          inArray(physicalDeliveries.status, ['verified', 'archived', 'released']),
        ),
      );
    for (const d of rows) {
      const owned = await this.instrumentsOfDelivery(d.id);
      if (owned.every((i) => i.status === 'verified' || i.status === 'held')) return true;
    }
    return false;
  }

  /** DELIVERY_STATUS (owner 1405/07/29, ج۵): the cheques the cheque rule counts. */
  async checkedCheques(creditApplicationId: string): Promise<CheckedCheque[]> {
    return this.db
      .select({
        role: instruments.role,
        guarantorId: instruments.guarantorId,
        amountRial: instruments.amountRial,
      })
      .from(instruments)
      .where(
        and(
          eq(instruments.creditApplicationId, creditApplicationId),
          eq(instruments.kind, 'cheque'),
          inArray(instruments.status, CHECKED_CHEQUE),
          isNull(instruments.deletedAt),
        ),
      );
  }

  // --- the owner's side -------------------------------------------------------------

  async mine(accountId: string) {
    const applications = await this.credit.applicationsOf(await this.personsOf(accountId));
    if (applications.length === 0) return [];
    const rows = await this.db
      .select()
      .from(physicalDeliveries)
      .where(inArray(physicalDeliveries.creditApplicationId, applications))
      .orderBy(desc(physicalDeliveries.createdAt));
    return Promise.all(rows.map((r) => this.myView(r)));
  }

  /** Task 6-9: the instruments this patient issued (as borrower or guarantor), last four only. */
  async myInstruments(accountId: string): Promise<MyInstrument[]> {
    const persons = await this.personsOf(accountId);
    if (persons.length === 0) return [];
    const rows = await this.db
      .select()
      .from(instruments)
      .where(and(inArray(instruments.issuerPersonId, persons), isNull(instruments.deletedAt)))
      .orderBy(asc(instruments.createdAt));
    return rows.map((r) => ({
      id: r.id,
      creditApplicationId: r.creditApplicationId,
      kind: r.kind,
      role: r.role,
      amountRial: r.amountRial.toString(),
      dueOn: r.dueOn,
      numberLast4: r.numberLast4,
      status: r.status,
    }));
  }

  /** The patient or borrower says how it was sent. */
  async markSent(
    actor: Actor,
    accountId: string,
    id: string,
    input: { method: Method; trackingCode?: string | undefined },
  ) {
    const persons = await this.personsOf(accountId);
    const row = await this.deliveryRow(id);
    const facts = await this.credit.facts(row.creditApplicationId);
    if (
      !facts ||
      (!persons.includes(facts.patientPersonId) && !persons.includes(facts.borrowerPersonId))
    ) {
      throw deliveryNotFound();
    }
    await this.move(actor, row.id, ['awaiting_send'], 'sent', {
      method: input.method,
      trackingCode: input.trackingCode ?? null,
      sentAt: new Date(),
    });
    return this.myView(await this.deliveryRow(row.id));
  }

  // --- helpers ----------------------------------------------------------------------

  private async move(
    actor: Actor,
    id: string,
    from: readonly DeliveryStatus[],
    to: DeliveryStatus,
    set: Partial<typeof physicalDeliveries.$inferInsert>,
    event?: string,
    after?: (tx: Tx) => Promise<void>,
  ) {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(physicalDeliveries)
        .where(eq(physicalDeliveries.id, id))
        .for('update');
      if (!locked) throw deliveryNotFound();
      if (!from.includes(locked.status)) {
        throw new ConflictException({ error: 'wrong_status', status: locked.status });
      }
      await tx
        .update(physicalDeliveries)
        .set({ ...set, status: to })
        .where(eq(physicalDeliveries.id, id));
      await this.audit.record(
        {
          actor,
          action: 'instrument.delivery_status_changed',
          entityType: 'physical_delivery',
          entityId: id,
          before: { status: locked.status },
          after: { status: to },
        },
        tx,
      );
      if (after) await after(tx);
      if (event) {
        await this.outbox.publish(
          {
            type: event,
            aggregateType: 'physical_delivery',
            aggregateId: id,
            payload: { deliveryId: id, creditApplicationId: locked.creditApplicationId },
          },
          tx,
        );
      }
    });
  }

  private itemsOf(deliveryId: string) {
    return this.db
      .select()
      .from(physicalDeliveryItems)
      .where(eq(physicalDeliveryItems.deliveryId, deliveryId))
      .orderBy(asc(physicalDeliveryItems.createdAt), asc(physicalDeliveryItems.id));
  }

  private instrumentsOfDelivery(deliveryId: string) {
    return this.db
      .select()
      .from(instruments)
      .where(eq(instruments.deliveryId, deliveryId))
      .orderBy(asc(instruments.createdAt));
  }

  private async deliveryView(row: DeliveryRow): Promise<DeliveryView> {
    const [items, owned] = await Promise.all([
      this.itemsOf(row.id),
      this.instrumentsOfDelivery(row.id),
    ]);
    return {
      id: row.id,
      creditApplicationId: row.creditApplicationId,
      status: row.status,
      method: row.method,
      trackingCode: row.trackingCode,
      receivedAt: row.receivedAt?.toISOString() ?? null,
      archiveLocation: row.archiveLocation,
      items: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        label: i.label,
        status: i.status,
        instrumentId: owned.find((o) => o.itemId === i.id)?.id ?? null,
      })),
      instruments: owned.map((o) => this.instrumentView(o)),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async myView(row: DeliveryRow) {
    const items = await this.itemsOf(row.id);
    return {
      id: row.id,
      creditApplicationId: row.creditApplicationId,
      status: row.status,
      method: row.method,
      items: items.map((i) => ({ id: i.id, label: i.label, status: i.status })),
    };
  }

  private instrumentView(r: InstrumentRow): InstrumentView {
    return {
      id: r.id,
      creditApplicationId: r.creditApplicationId,
      deliveryId: r.deliveryId,
      kind: r.kind,
      role: r.role,
      guarantorId: r.guarantorId,
      amountRial: r.amountRial.toString(),
      dueOn: r.dueOn,
      bankName: r.bankName,
      numberLast4: r.numberLast4,
      sayadConfirmed: r.sayadRegisteredConfirmed,
      sayadConfirmedAt: r.sayadConfirmedAt?.toISOString() ?? null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private async deliveryRow(id: string): Promise<DeliveryRow> {
    if (!UUID.test(id)) throw deliveryNotFound();
    const [row] = await this.db
      .select()
      .from(physicalDeliveries)
      .where(eq(physicalDeliveries.id, id));
    if (!row) throw deliveryNotFound();
    return row;
  }

  private async instrumentRow(id: string): Promise<InstrumentRow> {
    if (!UUID.test(id)) throw instrumentNotFound();
    const [row] = await this.db.select().from(instruments).where(eq(instruments.id, id));
    if (!row) throw instrumentNotFound();
    return row;
  }

  private async staffDelivery(access: EffectiveAccess, id: string) {
    const row = await this.deliveryRow(id);
    await this.reachable(access, row.creditApplicationId).catch(() => {
      throw deliveryNotFound();
    });
    return row;
  }

  private async staffInstrument(access: EffectiveAccess, id: string) {
    const row = await this.instrumentRow(id);
    await this.reachable(access, row.creditApplicationId).catch(() => {
      throw instrumentNotFound();
    });
    return row;
  }

  /** The application, if the caller's scope reaches it: global, or its proforma's city. */
  private async reachable(
    access: EffectiveAccess,
    creditApplicationId: string,
  ): Promise<CreditContractFacts> {
    const facts = await this.credit.facts(creditApplicationId);
    if (!facts) throw new NotFoundException({ error: 'credit_application_not_found' });
    if (access.scopes.some((s) => s.kind === 'global')) return facts;
    const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
    const proforma = await this.proformas.proforma(facts.proformaId);
    if (!proforma || !cities.includes(proforma.cityCode)) {
      throw new NotFoundException({ error: 'credit_application_not_found' });
    }
    return facts;
  }

  private async personsOf(accountId: string): Promise<string[]> {
    const account = await this.accounts.find(accountId);
    if (!account || account.kind !== 'patient')
      throw new ForbiddenException({ error: 'patients_only' });
    if (!account.personId) return [];
    return this.leads.samePersonIds(await this.leads.canonicalPersonId(account.personId));
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }
}
