import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { Actor, SqlExecutor } from '../../common/audit/audit.port';
import type {
  AssignmentEngine,
  AssignmentKey,
  AssignmentPick,
} from '../../common/lead/assignment-engine.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import {
  assignmentRrState,
  assignmentWeights,
  assignmentWeightVersions,
  caseAssignments,
  cases,
} from './lead.schema';
import { lockKey, type Tx } from './lead.shared';
import { pickWeighted } from './round-robin';

type CaseRow = typeof cases.$inferSelect;
type VersionRow = typeof assignmentWeightVersions.$inferSelect;

export interface AssignmentOutcome {
  readonly accountId: string | null;
  readonly kind: 'auto' | 'returning' | 'manual' | 'unassigned';
  readonly weightVersionId: string | null;
}

/**
 * Who gets a case (doc 05 §6). The shares in force for the case's queue, city and treatment
 * field (the most specific version that has started) choose by smooth weighted round-robin,
 * one pick at a time under the version's lock, so no case goes to two agents and no two
 * picks see the same credits. Agents away, on leave, at their open-case cap or with a zero
 * share take no part; when nobody can take the case it waits in `unassigned` and the
 * manager is told (an outbox event).
 *
 * A returning person goes back to their previous advisor (`previousAssignee`, given only
 * while `lead.returning_to_previous_agent` is on) when that advisor could take them now;
 * such a pick does not touch the credits.
 */
@Injectable()
export class AssignmentService implements AssignmentEngine {
  constructor(@Inject(OUTBOX) private readonly outbox: OutboxPort) {}

  async assign(
    tx: Tx,
    actor: Actor,
    kase: CaseRow,
    previousAssignee: string | null,
    now = new Date(),
  ): Promise<AssignmentOutcome> {
    const version = await this.versionFor(tx, kase, now);
    if (version) {
      await lockKey(tx, `lead.assign:${version.id}`);
      const weights = await this.weightsOf(tx, version.id);
      const eligible = await this.eligible(
        tx,
        weights.filter((w) => w.percent > 0).map((w) => w.accountId),
      );

      if (previousAssignee !== null && eligible.has(previousAssignee)) {
        return this.record(tx, actor, kase, {
          accountId: previousAssignee,
          kind: 'returning',
          weightVersionId: null,
        });
      }

      const accountId = await this.roundRobin(
        tx,
        version.id,
        weights.filter((w) => eligible.has(w.accountId)),
      );
      if (accountId !== null) {
        return this.record(tx, actor, kase, {
          accountId,
          kind: 'auto',
          weightVersionId: version.id,
        });
      }
    }
    return this.record(tx, actor, kase, {
      accountId: null,
      kind: 'unassigned',
      weightVersionId: null,
    });
  }

  /**
   * ASSIGNMENT_ENGINE (task 3-5): the same choice for another module's queue, whose open
   * items it counts itself. Nothing is recorded here; the caller records the pick.
   */
  async pick(
    executor: SqlExecutor,
    key: AssignmentKey,
    openOf: (accountIds: readonly string[]) => Promise<ReadonlyMap<string, number>>,
    now = new Date(),
  ): Promise<AssignmentPick | null> {
    const tx = executor as Tx;
    const version = await this.versionFor(tx, key, now);
    if (!version) return null;
    await lockKey(tx, `lead.assign:${version.id}`);
    const weights = await this.weightsOf(tx, version.id);
    const eligible = await this.eligible(
      tx,
      weights.filter((w) => w.percent > 0).map((w) => w.accountId),
      openOf,
    );
    const accountId = await this.roundRobin(
      tx,
      version.id,
      weights.filter((w) => eligible.has(w.accountId)),
    );
    return accountId === null ? null : { accountId, weightVersionId: version.id };
  }

  private weightsOf(tx: Tx, versionId: string) {
    return tx
      .select({ accountId: assignmentWeights.accountId, percent: assignmentWeights.percent })
      .from(assignmentWeights)
      .where(eq(assignmentWeights.versionId, versionId));
  }

  /** One smooth weighted round-robin pick among these contenders, its credits stored. */
  private async roundRobin(
    tx: Tx,
    versionId: string,
    contenders: readonly { accountId: string; percent: number }[],
  ): Promise<string | null> {
    if (contenders.length === 0) return null;
    await tx
      .insert(assignmentRrState)
      .values(contenders.map((c) => ({ versionId, accountId: c.accountId })))
      .onConflictDoNothing();
    const states = await tx
      .select()
      .from(assignmentRrState)
      .where(
        and(
          eq(assignmentRrState.versionId, versionId),
          inArray(
            assignmentRrState.accountId,
            contenders.map((c) => c.accountId),
          ),
        ),
      );
    const credit = new Map(states.map((s) => [s.accountId, s.currentWeight]));
    const pick = pickWeighted(
      contenders.map((c) => ({ ...c, credit: credit.get(c.accountId) ?? 0 })),
    );
    if (!pick) return null;
    for (const [accountId, value] of pick.credits) {
      await tx
        .update(assignmentRrState)
        .set({ currentWeight: value })
        .where(
          and(
            eq(assignmentRrState.versionId, versionId),
            eq(assignmentRrState.accountId, accountId),
          ),
        );
    }
    return pick.accountId;
  }

  /** Writes the assignment, points the case at it, and tells whoever needs to know. */
  async record(
    tx: Tx,
    actor: Actor,
    kase: CaseRow,
    outcome: AssignmentOutcome,
    reason: string | null = null,
  ): Promise<AssignmentOutcome> {
    await tx.insert(caseAssignments).values({
      caseId: kase.id,
      accountId: outcome.accountId,
      kind: outcome.kind,
      weightVersionId: outcome.weightVersionId,
      reason,
      createdBy: actor.accountId,
    });
    await tx
      .update(cases)
      .set({ assigneeAccountId: outcome.accountId })
      .where(eq(cases.id, kase.id));
    if (outcome.accountId === null) {
      await this.outbox.publish(
        {
          type: 'lead.case_unassigned',
          aggregateType: 'case',
          aggregateId: kase.id,
          payload: { caseId: kase.id, queueCode: kase.queueCode },
        },
        tx,
      );
    } else {
      await this.outbox.publish(
        {
          type: 'lead.case_assigned',
          aggregateType: 'case',
          aggregateId: kase.id,
          payload: {
            caseId: kase.id,
            accountId: outcome.accountId,
            kind: outcome.kind as 'auto' | 'returning' | 'manual',
          },
        },
        tx,
      );
    }
    return outcome;
  }

  /**
   * The shares in force for this case: city and field, then city, then field, then the
   * queue alone; the latest version of that key that has started.
   */
  async versionFor(tx: Tx, kase: AssignmentKey, now: Date): Promise<VersionRow | null> {
    const [row] = await tx
      .select()
      .from(assignmentWeightVersions)
      .where(
        and(
          eq(assignmentWeightVersions.queueCode, kase.queueCode),
          sql`(${assignmentWeightVersions.cityCode} IS NULL OR ${assignmentWeightVersions.cityCode} = ${kase.cityCode})`,
          sql`(${assignmentWeightVersions.treatmentFieldCode} IS NULL OR ${assignmentWeightVersions.treatmentFieldCode} = ${kase.treatmentFieldCode})`,
          sql`${assignmentWeightVersions.effectiveAt} <= ${now}`,
        ),
      )
      .orderBy(
        sql`(${assignmentWeightVersions.cityCode} IS NOT NULL) DESC`,
        sql`(${assignmentWeightVersions.treatmentFieldCode} IS NOT NULL) DESC`,
        desc(assignmentWeightVersions.effectiveAt),
        desc(assignmentWeightVersions.id),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Of these agents, those present (or never marked otherwise) and below their cap of
   * open items: open cases by default, or what `openOf` counts for another queue.
   */
  async eligible(
    tx: Tx,
    accountIds: readonly string[],
    openOf?: (accountIds: readonly string[]) => Promise<ReadonlyMap<string, number>>,
  ): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    const ids = sql.join(
      accountIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const presence = await tx.execute(sql`
      SELECT DISTINCT ON (account_id) account_id, status FROM agent_presence
      WHERE account_id IN (${ids}) ORDER BY account_id, created_at DESC, id DESC
    `);
    const caps = await tx.execute(sql`
      SELECT DISTINCT ON (account_id) account_id, max_open_cases FROM agent_caps
      WHERE account_id IN (${ids}) ORDER BY account_id, created_at DESC, id DESC
    `);
    const openCounts = openOf
      ? await openOf(accountIds)
      : new Map(
          (
            await tx
              .select({ accountId: cases.assigneeAccountId, count: sql<number>`count(*)::int` })
              .from(cases)
              .where(
                and(
                  inArray(cases.assigneeAccountId, [...accountIds]),
                  notInArray(cases.status, ['completed', 'cancelled']),
                  isNull(cases.deletedAt),
                ),
              )
              .groupBy(cases.assigneeAccountId)
          ).map((o) => [o.accountId ?? '', o.count]),
        );
    const away = new Set(
      presence.rows.filter((r) => r['status'] !== 'present').map((r) => r['account_id'] as string),
    );
    const cap = new Map(
      caps.rows.map((r) => [r['account_id'] as string, r['max_open_cases'] as number | null]),
    );
    return new Set(
      accountIds.filter((id) => {
        if (away.has(id)) return false;
        const max = cap.get(id);
        return max === undefined || max === null || (openCounts.get(id) ?? 0) < max;
      }),
    );
  }
}
