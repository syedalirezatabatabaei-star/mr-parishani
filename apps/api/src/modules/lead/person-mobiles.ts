import { and, asc, count, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Database } from '../../db/database.module';
import { personMobiles } from './lead.schema';
import type { Tx } from './lead.shared';

type Ex = Tx | Database;
export type PersonMobileRow = typeof personMobiles.$inferSelect;
export type AddedVia = NonNullable<PersonMobileRow['addedVia']>;

const live = isNull(personMobiles.deletedAt);
/** What every read that gives access or sends an SMS sees: live and not pending. */
const active = and(live, eq(personMobiles.status, 'active'));

/**
 * The only door to person_mobiles (task 9-3, go-live blocker م۵): a pending mobile, added to a
 * Person who already existed, gives nothing of that Person and gets no SMS. Every read here
 * filters it out, but for the three named below that must see it, and only to refuse or
 * restrict: {@link PersonMobiles.holder} (one mobile, one Person: the lookup that keeps a
 * pending mobile from making a second Person, and from booking or linking as the first),
 * {@link PersonMobiles.countKnown} (the import preview's count) and the pending lists of
 * the approvals. test/lead/person-mobiles-reads checks that nothing else reads the table.
 */
export const PersonMobiles = {
  // --- reads that give access or an SMS: active only ---------------------------------------

  /** The live, approved mobiles of these persons, oldest first. */
  async activeOf(ex: Ex, personIds: readonly string[]): Promise<PersonMobileRow[]> {
    if (personIds.length === 0) return [];
    return ex
      .select()
      .from(personMobiles)
      .where(and(active, inArray(personMobiles.personId, [...personIds])))
      .orderBy(asc(personMobiles.createdAt));
  },

  /** The Person's first approved mobile: where every SMS to them goes. */
  async firstActive(ex: Ex, personId: string): Promise<string | null> {
    const [row] = await ex
      .select({ mobile: personMobiles.mobile })
      .from(personMobiles)
      .where(and(active, eq(personMobiles.personId, personId)))
      .orderBy(asc(personMobiles.createdAt))
      .limit(1);
    return row?.mobile ?? null;
  },

  /** The approved mobiles of these persons whose holder has logged in with them: R2's readers. */
  async provedOf(ex: Ex, personIds: readonly string[]): Promise<PersonMobileRow[]> {
    if (personIds.length === 0) return [];
    return ex
      .select()
      .from(personMobiles)
      .where(
        and(
          active,
          isNotNull(personMobiles.provedAt),
          inArray(personMobiles.personId, [...personIds]),
        ),
      )
      .orderBy(asc(personMobiles.createdAt));
  },

  /** The Person of an approved mobile. */
  async personOfActive(ex: Ex, mobile: string): Promise<string | null> {
    const [row] = await ex
      .select({ personId: personMobiles.personId })
      .from(personMobiles)
      .where(and(active, eq(personMobiles.mobile, mobile)));
    return row?.personId ?? null;
  },

  /** These rows' mobiles, if still live and approved (the notices' recipients). */
  async activeByIds(ex: Ex, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await ex
      .select({ mobile: personMobiles.mobile })
      .from(personMobiles)
      .where(and(active, inArray(personMobiles.id, [...ids])));
    return rows.map((r) => r.mobile);
  },

  // --- reads that see pending, to refuse or restrict only ---------------------------------

  /**
   * The live row of a mobile, pending or not. Only to keep one Person per mobile, and to
   * refuse or restrict a pending one: never to give access by it.
   */
  async holder(ex: Ex, mobile: string): Promise<PersonMobileRow | null> {
    const [row] = await ex
      .select()
      .from(personMobiles)
      .where(and(live, eq(personMobiles.mobile, mobile)));
    return row ?? null;
  },

  /** How many of these mobiles some Person already has (import preview: new versus known). */
  async countKnown(ex: Ex, mobiles: readonly string[]): Promise<number> {
    if (mobiles.length === 0) return 0;
    const [row] = await ex
      .select({ n: count() })
      .from(personMobiles)
      .where(and(live, inArray(personMobiles.mobile, [...mobiles])));
    return row?.n ?? 0;
  },

  /** The pending mobiles of these persons, for those who may decide on them. */
  async pendingOf(ex: Ex, personIds: readonly string[]): Promise<PersonMobileRow[]> {
    if (personIds.length === 0) return [];
    return ex
      .select()
      .from(personMobiles)
      .where(
        and(
          live,
          eq(personMobiles.status, 'pending'),
          inArray(personMobiles.personId, [...personIds]),
        ),
      )
      .orderBy(asc(personMobiles.createdAt));
  },

  /** Every pending mobile, oldest deadline first: the queue of staff who may decide. */
  async pendingAll(ex: Ex): Promise<PersonMobileRow[]> {
    return ex
      .select()
      .from(personMobiles)
      .where(and(live, eq(personMobiles.status, 'pending')))
      .orderBy(asc(personMobiles.pendingExpiresAt))
      .limit(500);
  },

  /** One pending mobile, locked for its decision. */
  async lockPending(tx: Tx, id: string): Promise<PersonMobileRow | null> {
    const [row] = await tx
      .select()
      .from(personMobiles)
      .where(and(live, eq(personMobiles.status, 'pending'), eq(personMobiles.id, id)))
      .for('update');
    return row ?? null;
  },

  /** The pending mobiles an import batch added, locked: its cancel refuses them. */
  async lockPendingOfBatch(tx: Tx, batchId: string): Promise<PersonMobileRow[]> {
    return tx
      .select()
      .from(personMobiles)
      .where(
        and(live, eq(personMobiles.status, 'pending'), eq(personMobiles.importBatchId, batchId)),
      )
      .orderBy(asc(personMobiles.createdAt))
      .for('update');
  },

  /** Pending mobiles past their deadline, locked; others' runs skip them. */
  async lockOverdue(tx: Tx, now: Date, limit: number): Promise<PersonMobileRow[]> {
    return tx
      .select()
      .from(personMobiles)
      .where(
        and(live, eq(personMobiles.status, 'pending'), lte(personMobiles.pendingExpiresAt, now)),
      )
      .orderBy(asc(personMobiles.pendingExpiresAt))
      .limit(limit)
      .for('update', { skipLocked: true });
  },

  // --- writes -------------------------------------------------------------------------------

  /**
   * Every insert says its status (the column has no default, migration 0081): `active` only
   * for the one mobile of a Person made with it; `pending`, with its deadline, otherwise.
   */
  async add(
    tx: Tx,
    input: {
      personId: string;
      mobile: string;
      addedVia: AddedVia;
      addedBy: string | null;
      importBatchId?: string | null;
      provedAt?: Date | null;
    } & ({ status: 'active' } | { status: 'pending'; pendingExpiresAt: Date }),
  ): Promise<PersonMobileRow> {
    const [row] = await tx
      .insert(personMobiles)
      .values({
        personId: input.personId,
        mobile: input.mobile,
        status: input.status,
        addedVia: input.addedVia,
        addedBy: input.addedBy,
        importBatchId: input.importBatchId ?? null,
        provedAt: input.provedAt ?? null,
        pendingExpiresAt: input.status === 'pending' ? input.pendingExpiresAt : null,
      })
      .returning();
    if (!row) throw new Error('person mobile insert returned nothing');
    return row;
  },

  /** Its first OTP login, kept; later ones change nothing. */
  async markProved(ex: Ex, mobile: string, at: Date): Promise<void> {
    await ex
      .update(personMobiles)
      .set({ provedAt: at })
      .where(and(live, eq(personMobiles.mobile, mobile), isNull(personMobiles.provedAt)));
  },

  async approve(tx: Tx, id: string): Promise<void> {
    await tx.update(personMobiles).set({ status: 'active' }).where(eq(personMobiles.id, id));
  },

  /** Refused: rejected and soft-deleted (rule 7), which frees the mobile for a Person of its own. */
  async reject(tx: Tx, id: string, at: Date): Promise<void> {
    await tx
      .update(personMobiles)
      .set({ status: 'rejected', deletedAt: at })
      .where(eq(personMobiles.id, id));
  },

  /**
   * An approved mobile that a merge (or its revert) puts before other records: the row is
   * retired and the same mobile added again, pending until the deadline, its proof kept. A
   * status never goes back to pending (trigger), so this is a new row, and the history stays.
   */
  async reissuePending(
    tx: Tx,
    row: PersonMobileRow,
    input: { addedBy: string | null; pendingExpiresAt: Date; at: Date },
  ): Promise<PersonMobileRow> {
    await tx.update(personMobiles).set({ deletedAt: input.at }).where(eq(personMobiles.id, row.id));
    return PersonMobiles.add(tx, {
      personId: row.personId,
      mobile: row.mobile,
      status: 'pending',
      addedVia: 'merge',
      addedBy: input.addedBy,
      provedAt: row.provedAt,
      pendingExpiresAt: input.pendingExpiresAt,
    });
  },

  /**
   * A mobile its holder replaced with another (ف۱۲): soft-deleted (rule 7), which frees it for
   * whoever has the number next. The row, and its proof, stay as history.
   */
  async retire(tx: Tx, id: string, at: Date): Promise<void> {
    await tx
      .update(personMobiles)
      .set({ deletedAt: at })
      .where(and(live, eq(personMobiles.id, id)));
  },

  /** An import undone: the mobiles of the Person it made (task 2-5b). */
  async retireOfPerson(tx: Tx, personId: string, at: Date): Promise<void> {
    await tx
      .update(personMobiles)
      .set({ deletedAt: at })
      .where(and(live, eq(personMobiles.personId, personId)));
  },
};
