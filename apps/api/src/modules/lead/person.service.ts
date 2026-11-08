import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  normalizeMobile,
  OPEN_CASE_STATUSES,
  type BlockKind,
  type PersonDirectory,
} from '@sepehr/contracts';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { assertFreshMfa } from '../../common/auth/fresh-mfa';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { DATABASE, type Database } from '../../db/database.module';
import { lastFour } from '../../security/blind-index';
import { LEAD_CRYPTO, PERSON_NATIONAL_ID, type LeadCrypto } from './lead.crypto';
import { cases, personMerges, persons } from './lead.schema';
import { lockKey, requirePermission, systemActor, UUID, type Tx } from './lead.shared';
import { PersonMobiles, type AddedVia, type PersonMobileRow } from './person-mobiles';

export type PersonRow = typeof persons.$inferSelect;

export interface PersonView {
  readonly id: string;
  readonly displayName: string | null;
  /** The approved mobiles only (task 9-3). */
  readonly mobiles: string[];
  /** Mobiles added to this Person and not yet approved: they stand for nobody until then. */
  readonly pendingMobiles: {
    id: string;
    mobile: string;
    addedVia: AddedVia | null;
    addedAt: string;
    expiresAt: string | null;
  }[];
  /** The last four digits only (rule 27). */
  readonly nationalIdLast4: string | null;
  readonly blocked: { kind: BlockKind; at: string; reason: string } | null;
  readonly smsOptedOutAt: string | null;
}

export interface FoundPerson {
  readonly person: PersonRow;
  readonly created: boolean;
  /** A national ID given with the intake that already belongs to another person. */
  readonly nationalIdConflict: boolean;
  /**
   * Task 9-3: the mobile is pending on this Person (added now, or before and not yet
   * approved). Staff may go on working the Person; nothing of it is given by the mobile.
   */
  readonly mobilePending: boolean;
}

/** What a pending mobile's change is told as (R2). */
export type MobileChange = 'added' | 'approved' | 'rejected';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Merges nest at most this deep; more means a broken chain, not a person. */
const MAX_MERGE_DEPTH = 20;

/**
 * Persons (task 2-5b, doc 05 §3, §9): one per human, found by a normalized mobile (rule 24)
 * or a national ID's blind index (rule 27), never created twice for one mobile (an advisory
 * lock per mobile). A merge keeps both rows: the merged person points to the survivor, its
 * cases move, and every lookup follows the pointer, so a merge can be reverted exactly.
 *
 * Also the real PERSON_DIRECTORY of the identity module (task 0-4 port, unchanged).
 */
@Injectable()
export class PersonService implements PersonDirectory {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(LEAD_CRYPTO) private readonly crypto: LeadCrypto,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  // --- PERSON_DIRECTORY ------------------------------------------------------------------

  findOrCreateByMobile(mobile: string): Promise<{ personId: string | null }> {
    return this.directoryPerson(mobile, null);
  }

  linkLogin(mobile: string, at: Date): Promise<{ personId: string | null }> {
    return this.directoryPerson(mobile, at);
  }

  mobilesByIds(ids: readonly string[]): Promise<string[]> {
    return PersonMobiles.activeByIds(this.db, ids);
  }

  /**
   * Whether a login with this mobile still stands for the Person its account is linked to
   * (task 9-3): the mobile is approved and live, on that Person or one merged with them. Not
   * while a merge's re-issue of it is pending, nor once refused.
   */
  async standsFor(mobile: string, personId: string): Promise<boolean> {
    const normalized = normalizeMobile(mobile);
    if (normalized === null) return false;
    const of = await PersonMobiles.personOfActive(this.db, normalized);
    if (of === null) return false;
    const [a, b] = await Promise.all([
      this.canonical(this.db, of),
      this.canonical(this.db, personId),
    ]);
    return a.id === b.id;
  }

  /** The Person a mobile stands for; none while it is pending (task 9-3). */
  private async directoryPerson(
    mobile: string,
    provedAt: Date | null,
  ): Promise<{ personId: string | null }> {
    const normalized = normalizeMobile(mobile);
    if (normalized === null) throw new Error('not a mobile number');
    return this.db.transaction(async (tx) => {
      const { person, mobilePending } = await this.findOrCreate(
        tx,
        systemActor('lead.person_directory'),
        { mobile: normalized, addedVia: 'person_created' },
      );
      if (provedAt !== null) await PersonMobiles.markProved(tx, normalized, provedAt);
      if (mobilePending) return { personId: null };
      if (person.accountLinkedAt === null) {
        await tx
          .update(persons)
          .set({ accountLinkedAt: new Date() })
          .where(eq(persons.id, person.id));
      }
      return { personId: person.id };
    });
  }

  // --- finding and creating --------------------------------------------------------------

  /**
   * The one person of this mobile, created if none; with a national ID, the person who
   * already has it. Takes the mobile's lock for the rest of the transaction, so two intakes
   * of one mobile never make two persons.
   *
   * Task 9-3 (go-live blocker م۵): a national ID is no secret, so a mobile added to a Person
   * who already existed is pending: it stands for nobody and gets no SMS, and the Person's
   * proved mobiles are told at once (R2), until it is approved (PersonMobileApprovalService).
   * With `onExisting: 'refuse'` (a credit transfer's recipient) it is refused instead, and so
   * is a mobile already pending.
   */
  async findOrCreate(
    tx: Tx,
    actor: Actor,
    input: {
      mobile: string;
      name?: string | null;
      nationalId?: string | null;
      importBatchId?: string | null;
      addedVia: AddedVia;
      onExisting?: 'pending' | 'refuse';
    },
  ): Promise<FoundPerson> {
    await lockKey(tx, `lead.mobile:${input.mobile}`);
    const held = await PersonMobiles.holder(tx, input.mobile);
    let person = held ? await this.canonical(tx, held.personId) : null;
    let mobilePending = held?.status === 'pending';
    if (mobilePending && input.onExisting === 'refuse') {
      throw new ConflictException({ error: 'recipient_mobile_pending' });
    }
    let nationalIdConflict = false;
    // ADR-042: the national ID's index under every key of the ring, so a person still indexed
    // under an older key is found during a rotation; one national ID at a time (a lock on its
    // index under the ring's lowest key, the same in every process).
    const indexes = input.nationalId
      ? this.crypto.blindIndex.allOf('national_id', input.nationalId)
      : null;
    if (input.nationalId) {
      await lockKey(
        tx,
        `lead.national_id:${this.crypto.blindIndex.stableOf('national_id', input.nationalId)}`,
      );
    }

    if (!person && indexes !== null) {
      const [byId] = await tx
        .select()
        .from(persons)
        .where(and(inArray(persons.nationalIdIndex, indexes), isNull(persons.deletedAt)));
      if (byId) {
        if (input.onExisting === 'refuse') {
          throw new ConflictException({ error: 'recipient_mobile_mismatch' });
        }
        person = await this.canonical(tx, byId.id);
        const added = await PersonMobiles.add(tx, {
          personId: person.id,
          mobile: input.mobile,
          status: 'pending',
          addedVia: input.addedVia,
          addedBy: actor.accountId,
          importBatchId: input.importBatchId ?? null,
          pendingExpiresAt: await this.pendingDeadline(new Date()),
        });
        mobilePending = true;
        await this.audit.record(
          {
            actor,
            action: 'lead.person_mobile_added',
            entityType: 'person',
            entityId: person.id,
            after: {
              personMobileId: added.id,
              mobileLast4: lastFour(input.mobile),
              status: 'pending',
              addedVia: input.addedVia,
              expiresAt: added.pendingExpiresAt?.toISOString() ?? null,
            },
          },
          tx,
        );
        await this.tellProved(tx, actor, 'added', added, person.id);
      }
    }
    if (!person) {
      const [row] = await tx
        .insert(persons)
        .values({
          displayName: input.name ?? null,
          ...(input.nationalId ? this.encryptNationalId(input.nationalId) : {}),
          importBatchId: input.importBatchId ?? null,
          createdBy: actor.accountId,
        })
        .returning();
      if (!row) throw new Error('person insert returned nothing');
      await PersonMobiles.add(tx, {
        personId: row.id,
        mobile: input.mobile,
        status: 'active',
        addedVia: input.addedVia,
        addedBy: actor.accountId,
      });
      await this.audit.record(
        {
          actor,
          action: 'lead.person_created',
          entityType: 'person',
          entityId: row.id,
          after: { mobileLast4: lastFour(input.mobile), nationalIdLast4: row.nationalIdLast4 },
        },
        tx,
      );
      return { person: row, created: true, nationalIdConflict: false, mobilePending: false };
    }

    // An existing person: fill what they lack, never overwrite.
    const set: Partial<typeof persons.$inferInsert> = {};
    if (input.name && person.displayName === null) set.displayName = input.name;
    if (input.nationalId && indexes !== null && person.nationalIdIndex === null) {
      const [other] = await tx
        .select({ id: persons.id })
        .from(persons)
        .where(and(inArray(persons.nationalIdIndex, indexes), isNull(persons.deletedAt)));
      if (other) nationalIdConflict = true;
      else Object.assign(set, this.encryptNationalId(input.nationalId));
    } else if (
      indexes !== null &&
      person.nationalIdIndex !== null &&
      // The same national ID under another key is the same national ID (ADR-042).
      !indexes.includes(person.nationalIdIndex)
    ) {
      nationalIdConflict = true;
    }
    if (Object.keys(set).length > 0) {
      const [row] = await tx.update(persons).set(set).where(eq(persons.id, person.id)).returning();
      if (row) person = row;
    }
    return { person, created: false, nationalIdConflict, mobilePending };
  }

  /** The person of an approved mobile, followed through any merge; never by a pending one. */
  async byActiveMobile(tx: Tx | Database, mobile: string): Promise<PersonRow | null> {
    const personId = await PersonMobiles.personOfActive(tx, mobile);
    return personId ? this.canonical(tx, personId) : null;
  }

  /**
   * The person of a live mobile, pending or not: only to restrict (a block reaches a pending
   * mobile too), never to give anything by it.
   */
  async holderOf(tx: Tx | Database, mobile: string): Promise<PersonRow | null> {
    const held = await PersonMobiles.holder(tx, mobile);
    return held ? this.canonical(tx, held.personId) : null;
  }

  /**
   * R2 for a pending mobile (task 9-3): the proved, approved mobiles of the Person (and of
   * everyone merged with them) are told through the outbox, after the commit; the event
   * carries row ids, never numbers. With none to tell, only the audit says so.
   */
  async tellProved(
    tx: Tx,
    actor: Actor,
    change: MobileChange,
    subject: PersonMobileRow | null,
    personId: string,
  ): Promise<void> {
    const ids = await this.mergedIds(tx, (await this.canonical(tx, personId)).id);
    const recipients = (await PersonMobiles.provedOf(tx, ids)).filter((m) => m.id !== subject?.id);
    if (recipients.length === 0) {
      await this.audit.record(
        {
          actor,
          action: 'lead.person_mobile_notice_skipped',
          entityType: 'person',
          entityId: personId,
          after: { change, personMobileId: subject?.id ?? null, reason: 'no_proved_mobile' },
        },
        tx,
      );
      return;
    }
    await this.outbox.publish(
      {
        type: 'lead.person_mobile_changed',
        aggregateType: 'person',
        aggregateId: personId,
        payload: {
          change,
          personMobileId: subject?.id ?? null,
          recipientIds: recipients.map((m) => m.id),
        },
      },
      tx,
    );
  }

  /** The person a merge chain ends at. */
  async canonical(tx: Tx | Database, personId: string): Promise<PersonRow> {
    let id = personId;
    for (let depth = 0; depth < MAX_MERGE_DEPTH; depth++) {
      const [row] = await tx.select().from(persons).where(eq(persons.id, id));
      if (!row) throw new NotFoundException({ error: 'person_not_found' });
      if (row.mergedIntoId === null) return row;
      id = row.mergedIntoId;
    }
    throw new Error(`merge chain of person ${personId} is too deep`);
  }

  async view(ex: Tx | Database, person: PersonRow): Promise<PersonView> {
    const ids = await this.mergedIds(ex, person.id);
    const mobiles = await PersonMobiles.activeOf(ex, ids);
    const pending = await PersonMobiles.pendingOf(ex, ids);
    return {
      id: person.id,
      displayName: person.displayName,
      mobiles: mobiles.map((m) => m.mobile),
      pendingMobiles: pending.map((m) => ({
        id: m.id,
        mobile: m.mobile,
        addedVia: m.addedVia,
        addedAt: m.createdAt.toISOString(),
        expiresAt: m.pendingExpiresAt?.toISOString() ?? null,
      })),
      nationalIdLast4: person.nationalIdLast4,
      blocked:
        person.blockedKind && person.blockedAt && person.blockedReason
          ? {
              kind: person.blockedKind,
              at: person.blockedAt.toISOString(),
              reason: person.blockedReason,
            }
          : null,
      smsOptedOutAt: person.smsOptedOutAt?.toISOString() ?? null,
    };
  }

  /** This person and everyone merged into them, at any depth. */
  async mergedIds(ex: Tx | Database, personId: string): Promise<string[]> {
    const rows = await ex.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT id FROM persons WHERE id = ${personId}
        UNION
        SELECT p.id FROM persons p JOIN chain c ON p.merged_into_id = c.id
      )
      SELECT id FROM chain
    `);
    return rows.rows.map((r) => r['id'] as string);
  }

  // --- blocking (doc 05 §4: abuse, or a request not to be contacted) ---------------------

  async block(
    actor: Actor,
    access: EffectiveAccess,
    personId: string,
    input: { kind: BlockKind; reason: string },
  ): Promise<PersonView> {
    requirePermission(access, 'lead.block_person');
    return this.db.transaction(async (tx) => {
      const person = await this.lockPerson(tx, personId);
      if (person.blockedAt !== null) throw new ConflictException({ error: 'person_blocked' });
      const [row] = await tx
        .update(persons)
        .set({ blockedKind: input.kind, blockedAt: new Date(), blockedReason: input.reason })
        .where(eq(persons.id, person.id))
        .returning();
      if (!row) throw new Error('person update returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'lead.person_blocked',
          entityType: 'person',
          entityId: person.id,
          before: { blocked: null },
          after: { blocked: input.kind },
          reason: input.reason,
        },
        tx,
      );
      return this.view(tx, row);
    });
  }

  async unblock(
    actor: Actor,
    access: EffectiveAccess,
    personId: string,
    reason: string,
  ): Promise<PersonView> {
    requirePermission(access, 'lead.block_person');
    return this.db.transaction(async (tx) => {
      const person = await this.lockPerson(tx, personId);
      if (person.blockedAt === null) throw new ConflictException({ error: 'person_not_blocked' });
      const [row] = await tx
        .update(persons)
        .set({ blockedKind: null, blockedAt: null, blockedReason: null })
        .where(eq(persons.id, person.id))
        .returning();
      if (!row) throw new Error('person update returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'lead.person_unblocked',
          entityType: 'person',
          entityId: person.id,
          before: { blocked: person.blockedKind, reason: person.blockedReason },
          after: { blocked: null },
          reason,
        },
        tx,
      );
      return this.view(tx, row);
    });
  }

  /** Records that the person asked for no more SMS (doc 05 §7). */
  async optOutOfSms(tx: Tx, actor: Actor, person: PersonRow, reason: string): Promise<PersonRow> {
    if (person.smsOptedOutAt !== null) return person;
    const [row] = await tx
      .update(persons)
      .set({ smsOptedOutAt: new Date() })
      .where(eq(persons.id, person.id))
      .returning();
    await this.audit.record(
      {
        actor,
        action: 'lead.person_sms_opted_out',
        entityType: 'person',
        entityId: person.id,
        reason,
      },
      tx,
    );
    return row ?? person;
  }

  // --- merging (doc 05 §9; task 2-5b decision 6) -----------------------------------------

  /**
   * One human registered twice: `merged`'s cases move to `survivor`, and `merged` points to
   * `survivor` from now on. Refused when both have national IDs that differ (two humans),
   * or both have an open case (close one first).
   */
  async merge(
    actor: Actor,
    access: EffectiveAccess,
    input: { survivorId: string; mergedId: string; reason: string },
    now = new Date(),
  ): Promise<{ mergeId: string; movedCaseIds: string[] }> {
    requirePermission(access, 'lead.merge_persons');
    // Task 9-3 (owner, 1405/07/19): a merge gives each side's mobiles the other's records.
    await assertFreshMfa(this.config, actor, now);
    return this.db.transaction(async (tx) => {
      const [first, second] = [input.survivorId, input.mergedId].sort();
      const locked = new Map<string, PersonRow>();
      for (const id of [first, second]) {
        if (id) locked.set(id, await this.lockPerson(tx, id));
      }
      const survivor = locked.get(input.survivorId);
      const merged = locked.get(input.mergedId);
      if (!survivor || !merged) throw new NotFoundException({ error: 'person_not_found' });
      if (survivor.mergedIntoId !== null || merged.mergedIntoId !== null) {
        throw new ConflictException({ error: 'person_already_merged' });
      }
      if (
        survivor.nationalIdIndex !== null &&
        merged.nationalIdIndex !== null &&
        survivor.nationalIdIndex !== merged.nationalIdIndex
      ) {
        throw new ConflictException({ error: 'national_id_conflict' });
      }
      const open = await tx
        .select({ personId: cases.personId })
        .from(cases)
        .where(
          and(
            inArray(cases.personId, [survivor.id, merged.id]),
            inArray(cases.status, [...OPEN_CASE_STATUSES]),
            isNull(cases.deletedAt),
          ),
        );
      if (new Set(open.map((o) => o.personId)).size === 2) {
        throw new ConflictException({ error: 'both_have_open_cases' });
      }
      const moved = await tx
        .update(cases)
        .set({ personId: survivor.id })
        .where(and(eq(cases.personId, merged.id), isNull(cases.deletedAt)))
        .returning({ id: cases.id });
      const movedCaseIds = moved.map((c) => c.id).sort();
      await tx.update(persons).set({ mergedIntoId: survivor.id }).where(eq(persons.id, merged.id));
      const [row] = await tx
        .insert(personMerges)
        .values({
          survivorId: survivor.id,
          mergedId: merged.id,
          movedCaseIds,
          reason: input.reason,
          createdBy: actor.accountId,
        })
        .returning();
      if (!row) throw new Error('merge insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'lead.persons_merged',
          entityType: 'person_merge',
          entityId: row.id,
          before: { survivorId: survivor.id, mergedId: merged.id, mergedIntoId: null },
          after: { survivorId: survivor.id, mergedId: merged.id, movedCaseIds },
          reason: input.reason,
        },
        tx,
      );
      // Owner 1405/07/19: the merged Person's mobiles now reach the survivor's records, so
      // each waits for approval like any mobile added to a Person, always (no exception, not
      // even one national ID). The survivor's proved mobiles are told of each (R2).
      await this.repend(tx, actor, merged.id, row.id, now);
      return { mergeId: row.id, movedCaseIds };
    });
  }

  /**
   * The merges this person survived, newest first (owner 1405/07/24: the merge section of the
   * case page, where each can be undone). Only for whoever may merge; ids, no personal data.
   */
  async mergesInto(access: EffectiveAccess, personId: string) {
    requirePermission(access, 'lead.merge_persons');
    if (!UUID.test(personId)) throw new NotFoundException({ error: 'person_not_found' });
    const rows = await this.db
      .select()
      .from(personMerges)
      .where(eq(personMerges.survivorId, personId))
      .orderBy(desc(personMerges.createdAt), desc(personMerges.id));
    return rows.map((m) => ({
      id: m.id,
      mergedId: m.mergedId,
      movedCaseIds: m.movedCaseIds,
      reason: m.reason,
      at: m.createdAt.toISOString(),
      revertedAt: m.revertedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Undoes a merge exactly: the cases it moved and that are still on the survivor go back,
   * and the merged person stands alone again. Once only; not after the survivor was itself
   * merged away.
   */
  async revertMerge(
    actor: Actor,
    access: EffectiveAccess,
    mergeId: string,
    reason: string,
    now = new Date(),
  ): Promise<{ restoredCaseIds: string[] }> {
    requirePermission(access, 'lead.merge_persons');
    await assertFreshMfa(this.config, actor, now);
    if (!UUID.test(mergeId)) throw new NotFoundException({ error: 'merge_not_found' });
    return this.db.transaction(async (tx) => {
      const [merge] = await tx
        .select()
        .from(personMerges)
        .where(eq(personMerges.id, mergeId))
        .for('update');
      if (!merge) throw new NotFoundException({ error: 'merge_not_found' });
      if (merge.revertedAt !== null) throw new ConflictException({ error: 'merge_reverted' });
      const survivor = await this.lockPerson(tx, merge.survivorId);
      const merged = await this.lockPerson(tx, merge.mergedId);
      if (survivor.mergedIntoId !== null) {
        throw new ConflictException({ error: 'survivor_merged_again' });
      }
      const restored =
        merge.movedCaseIds.length === 0
          ? []
          : await tx
              .update(cases)
              .set({ personId: merge.mergedId })
              .where(and(inArray(cases.id, merge.movedCaseIds), eq(cases.personId, survivor.id)))
              .returning({ id: cases.id });
      await tx.update(persons).set({ mergedIntoId: null }).where(eq(persons.id, merge.mergedId));
      await tx
        .update(personMerges)
        .set({ revertedAt: new Date(), revertedBy: actor.accountId, revertReason: reason })
        .where(eq(personMerges.id, merge.id));
      const restoredCaseIds = restored.map((c) => c.id).sort();
      // The same rule backwards: the mobiles of the Person who stands alone again are re-drawn
      // to other records, so they wait too.
      await this.repend(tx, actor, merged.id, merge.id, now);
      await this.audit.record(
        {
          actor,
          action: 'lead.merge_reverted',
          entityType: 'person_merge',
          entityId: merge.id,
          before: { mergedIntoId: survivor.id, movedCaseIds: merge.movedCaseIds },
          after: { mergedIntoId: null, restoredCaseIds },
          reason,
        },
        tx,
      );
      return { restoredCaseIds };
    });
  }

  // --- helpers ----------------------------------------------------------------------------

  /** A pending mobile's deadline, locked on the row (`lead.person_mobile_pending_days`). */
  private async pendingDeadline(now: Date): Promise<Date> {
    const { value: days } = await this.config.resolve('lead.person_mobile_pending_days', {}, now);
    return new Date(now.getTime() + days * DAY_MS);
  }

  /** A merge's or a revert's re-issue of one Person's approved mobiles as pending (task 9-3). */
  private async repend(
    tx: Tx,
    actor: Actor,
    personId: string,
    mergeId: string,
    now: Date,
  ): Promise<void> {
    const deadline = await this.pendingDeadline(now);
    const reissued: PersonMobileRow[] = [];
    for (const row of await PersonMobiles.activeOf(tx, [personId])) {
      const added = await PersonMobiles.reissuePending(tx, row, {
        addedBy: actor.accountId,
        pendingExpiresAt: deadline,
        at: now,
      });
      await this.audit.record(
        {
          actor,
          action: 'lead.person_mobile_added',
          entityType: 'person',
          entityId: personId,
          before: { personMobileId: row.id, status: 'active' },
          after: {
            personMobileId: added.id,
            mobileLast4: lastFour(row.mobile),
            status: 'pending',
            addedVia: 'merge',
            mergeId,
            expiresAt: deadline.toISOString(),
          },
        },
        tx,
      );
      reissued.push(added);
    }
    // Told once all are pending, so none of them is told of another.
    for (const added of reissued) await this.tellProved(tx, actor, 'added', added, personId);
  }

  async lockPerson(tx: Tx, personId: string): Promise<PersonRow> {
    if (!UUID.test(personId)) throw new NotFoundException({ error: 'person_not_found' });
    const [row] = await tx
      .select()
      .from(persons)
      .where(and(eq(persons.id, personId), isNull(persons.deletedAt)))
      .for('update');
    if (!row) throw new NotFoundException({ error: 'person_not_found' });
    return row;
  }

  private encryptNationalId(nationalId: string) {
    return {
      nationalIdEnc: this.crypto.fieldCrypto.encrypt(nationalId, PERSON_NATIONAL_ID),
      nationalIdIndex: this.crypto.blindIndex.of('national_id', nationalId),
      nationalIdLast4: lastFour(nationalId),
    };
  }
}
