import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  gregorianDayOf,
  normalizeMobile,
  toJalali,
  type ClubMembershipView,
  type recordClubMembershipSchema,
  type revokeClubMembershipSchema,
} from '@sepehr/contracts';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { DATABASE, type Database } from '../../db/database.module';
import { clubMembershipRevocations, clubMemberships } from './lead.schema';
import { requirePermission, type Tx } from './lead.shared';
import { PersonService } from './person.service';

const RECORD = 'lead.record_club_membership' as const;

type MembershipRow = typeof clubMemberships.$inferSelect;
type RevocationRow = typeof clubMembershipRevocations.$inferSelect;

const isUniqueViolation = (error: unknown) => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
};

/** Today in Tehran, as a Gregorian day (YYYY-MM-DD). */
export const tehranDay = (now: Date = new Date()) => gregorianDayOf(toJalali(now));

/**
 * The customer club (ADR-048; owner 1405/07/30, answer 2). A club officer records a membership:
 * its first day, its last (none: open), and why; it never changes (append-only, 0102). Ending
 * it early is a revocation from a day on, once. A Person merged into another keeps theirs: the
 * membership of any of the merged records counts (doc 05 §3).
 */
@Injectable()
export class ClubMembershipService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    private readonly persons: PersonService,
  ) {}

  async list(access: EffectiveAccess, mobileInput: string): Promise<ClubMembershipView[]> {
    requirePermission(access, RECORD);
    const personId = await this.personOf(mobileInput);
    const ids = await this.persons.mergedIds(this.db, personId);
    const rows = await this.db
      .select()
      .from(clubMemberships)
      .where(inArray(clubMemberships.personId, ids))
      .orderBy(asc(clubMemberships.startsOn), asc(clubMemberships.createdAt));
    return this.views(rows);
  }

  async record(
    actor: Actor,
    access: EffectiveAccess,
    input: z.output<typeof recordClubMembershipSchema>,
  ): Promise<ClubMembershipView> {
    requirePermission(access, RECORD);
    const recordedBy = this.accountOf(actor);
    const personId = await this.personOf(input.mobile);
    const row = await this.db.transaction(async (tx) => {
      const [made] = await tx
        .insert(clubMemberships)
        .values({
          personId,
          startsOn: input.startsOn,
          endsOn: input.endsOn ?? null,
          recordedBy,
          reason: input.reason,
        })
        .returning();
      if (!made) throw new Error('club membership insert returned nothing');
      await this.audit.record(
        {
          actor,
          action: 'lead.club_membership_recorded',
          entityType: 'person',
          entityId: personId,
          before: null,
          after: { membershipId: made.id, startsOn: made.startsOn, endsOn: made.endsOn },
          reason: input.reason,
        },
        tx,
      );
      return made;
    });
    return (await this.views([row]))[0] as ClubMembershipView;
  }

  async revoke(
    actor: Actor,
    access: EffectiveAccess,
    membershipId: string,
    input: z.output<typeof revokeClubMembershipSchema>,
  ): Promise<ClubMembershipView> {
    requirePermission(access, RECORD);
    const recordedBy = this.accountOf(actor);
    const row = await this.db
      .transaction(async (tx) => {
        const [membership] = await tx
          .select()
          .from(clubMemberships)
          .where(eq(clubMemberships.id, membershipId));
        if (!membership) throw new NotFoundException({ error: 'membership_not_found' });
        if (input.revokedOn < membership.startsOn) {
          throw new ConflictException({ error: 'revoked_before_start' });
        }
        if (membership.endsOn !== null && input.revokedOn > membership.endsOn) {
          throw new ConflictException({ error: 'revoked_after_end' });
        }
        await tx.insert(clubMembershipRevocations).values({
          membershipId,
          revokedOn: input.revokedOn,
          recordedBy,
          reason: input.reason,
        });
        await this.audit.record(
          {
            actor,
            action: 'lead.club_membership_revoked',
            entityType: 'person',
            entityId: membership.personId,
            before: { membershipId, endsOn: membership.endsOn },
            after: { membershipId, revokedOn: input.revokedOn },
            reason: input.reason,
          },
          tx,
        );
        return membership;
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw new ConflictException({ error: 'already_revoked' });
        throw error;
      });
    return (await this.views([row]))[0] as ClubMembershipView;
  }

  /**
   * The membership that counts for `personId` (or any Person merged with them) on `day`, or
   * null: begun, not past its last day, and not revoked by then. The latest begun wins.
   */
  async membershipAt(personId: string, day: string, ex: Tx | Database = this.db) {
    const ids = await this.persons.mergedIds(ex, personId);
    const rows = await ex.execute(sql`
      SELECT m.id FROM club_memberships m
      LEFT JOIN club_membership_revocations r ON r.membership_id = m.id
      WHERE m.person_id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
        AND m.starts_on <= ${day}::date
        AND (m.ends_on IS NULL OR m.ends_on >= ${day}::date)
        AND (r.id IS NULL OR r.revoked_on > ${day}::date)
      ORDER BY m.starts_on DESC, m.created_at DESC
      LIMIT 1
    `);
    return (rows.rows[0]?.['id'] as string | undefined) ?? null;
  }

  // --- helpers -------------------------------------------------------------------------

  private async personOf(mobileInput: string): Promise<string> {
    const mobile = normalizeMobile(mobileInput);
    if (mobile === null) throw new BadRequestException({ error: 'invalid_mobile' });
    // Never by a pending mobile (task 9-3): it stands for nobody yet.
    const person = await this.persons.byActiveMobile(this.db, mobile);
    if (!person) throw new NotFoundException({ error: 'person_not_found' });
    return (await this.persons.canonical(this.db, person.id)).id;
  }

  private accountOf(actor: Actor): string {
    if (actor.accountId === null) throw new ForbiddenException({ error: 'staff_only' });
    return actor.accountId;
  }

  private async views(rows: readonly MembershipRow[]): Promise<ClubMembershipView[]> {
    if (rows.length === 0) return [];
    const revocations = await this.db
      .select()
      .from(clubMembershipRevocations)
      .where(
        inArray(
          clubMembershipRevocations.membershipId,
          rows.map((r) => r.id),
        ),
      );
    const byMembership = new Map<string, RevocationRow>(
      revocations.map((r) => [r.membershipId, r]),
    );
    const today = tehranDay();
    return rows.map((m) => {
      const r = byMembership.get(m.id);
      return {
        id: m.id,
        personId: m.personId,
        startsOn: m.startsOn,
        endsOn: m.endsOn,
        reason: m.reason,
        recordedAt: m.createdAt.toISOString(),
        revocation: r
          ? { revokedOn: r.revokedOn, reason: r.reason, recordedAt: r.createdAt.toISOString() }
          : null,
        activeToday:
          m.startsOn <= today &&
          (m.endsOn === null || m.endsOn >= today) &&
          (r === undefined || r.revokedOn > today),
      };
    });
  }
}
