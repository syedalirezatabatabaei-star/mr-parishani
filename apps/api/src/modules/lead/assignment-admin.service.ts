import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AgentPresence } from '@sepehr/contracts';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { DATABASE, type Database } from '../../db/database.module';
import { REPORTING_DATABASE, type ReportingDatabase } from '../../db/reporting.module';
import {
  agentCaps,
  agentPresence,
  assignmentWeights,
  assignmentWeightVersions,
} from './lead.schema';
import { lockKey, requirePermission } from './lead.shared';

export interface SharesView {
  readonly versionId: string;
  readonly queueCode: string;
  readonly cityCode: string | null;
  readonly treatmentFieldCode: string | null;
  readonly effectiveAt: string;
  readonly shares: { accountId: string; percent: number }[];
}

/**
 * The panel's side of assignment (doc 05 §6), with lead.manage_assignment (task 2-5b
 * decision 6: the strategy manager): each queue's shares, optionally per city and
 * treatment field, as append-only versions whose counting starts over (decision 4); an
 * agent's presence and open-case cap. Every change audited. The target-versus-actual
 * report reads the reporting database, never the operational one (ADR-012).
 */
@Injectable()
export class AssignmentAdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REPORTING_DATABASE) private readonly reporting: ReportingDatabase,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(ACCOUNT_DIRECTORY) private readonly accounts: AccountDirectory,
  ) {}

  async setShares(
    actor: Actor,
    access: EffectiveAccess,
    input: {
      queueCode: string;
      cityCode?: string | undefined;
      treatmentFieldCode?: string | undefined;
      shares: { accountId: string; percent: number }[];
      reason: string;
    },
  ): Promise<SharesView> {
    requirePermission(access, 'lead.manage_assignment');
    await this.requireStaff(input.shares.map((s) => s.accountId));
    const key = [input.queueCode, input.cityCode ?? '*', input.treatmentFieldCode ?? '*'].join(':');
    return this.db.transaction(async (tx) => {
      await lockKey(tx, `lead.shares:${key}`);
      const before = await this.current(
        tx,
        input.queueCode,
        input.cityCode ?? null,
        input.treatmentFieldCode ?? null,
      );
      const [version] = await tx
        .insert(assignmentWeightVersions)
        .values({
          queueCode: input.queueCode,
          cityCode: input.cityCode ?? null,
          treatmentFieldCode: input.treatmentFieldCode ?? null,
          effectiveAt: new Date(),
          reason: input.reason,
          createdBy: actor.accountId,
        })
        .returning();
      if (!version) throw new Error('version insert returned nothing');
      await tx
        .insert(assignmentWeights)
        .values(input.shares.map((s) => ({ versionId: version.id, ...s })));
      const after: SharesView = {
        versionId: version.id,
        queueCode: version.queueCode,
        cityCode: version.cityCode,
        treatmentFieldCode: version.treatmentFieldCode,
        effectiveAt: version.effectiveAt.toISOString(),
        shares: [...input.shares].sort((a, b) => a.accountId.localeCompare(b.accountId)),
      };
      await this.audit.record(
        {
          actor,
          action: 'lead.assignment_shares_set',
          entityType: 'assignment_weight_version',
          entityId: version.id,
          before,
          after,
          reason: input.reason,
        },
        tx,
      );
      return after;
    });
  }

  async shares(
    access: EffectiveAccess,
    queueCode: string,
    cityCode: string | null,
    treatmentFieldCode: string | null,
  ): Promise<SharesView | null> {
    requirePermission(access, 'lead.manage_assignment');
    return this.current(this.db, queueCode, cityCode, treatmentFieldCode);
  }

  /**
   * The assignment page (owner 1405/07/24): the shares in force, each agent with the name the
   * page shows (display name, else username). Read only; the audit keeps the ids alone.
   */
  async sharesWithNames(
    access: EffectiveAccess,
    queueCode: string,
    cityCode: string | null,
    treatmentFieldCode: string | null,
  ) {
    const view = await this.shares(access, queueCode, cityCode, treatmentFieldCode);
    if (!view) return null;
    const shares = await Promise.all(
      view.shares.map(async (s) => {
        const [presence] = await this.db
          .select({ status: agentPresence.status })
          .from(agentPresence)
          .where(eq(agentPresence.accountId, s.accountId))
          .orderBy(desc(agentPresence.createdAt), desc(agentPresence.id))
          .limit(1);
        const [cap] = await this.db
          .select({ maxOpenCases: agentCaps.maxOpenCases })
          .from(agentCaps)
          .where(eq(agentCaps.accountId, s.accountId))
          .orderBy(desc(agentCaps.createdAt), desc(agentCaps.id))
          .limit(1);
        return {
          ...s,
          name: (await this.accounts.nameOf?.(s.accountId)) ?? null,
          // What the engine reads (AssignmentService.eligible): present and no cap if never set.
          presence: presence?.status ?? 'present',
          maxOpenCases: cap?.maxOpenCases ?? null,
        };
      }),
    );
    return { ...view, shares };
  }

  /**
   * An agent to add to a queue, found by username (owner 1405/07/24): an active staff account
   * only, never a center or a patient; no mobile.
   */
  async findAgent(access: EffectiveAccess, username: string) {
    requirePermission(access, 'lead.manage_assignment');
    const found = await this.accounts.findStaffByUsername?.(username);
    if (found?.kind !== 'staff' || found.status !== 'active') {
      throw new NotFoundException({ error: 'agent_not_found' });
    }
    return { id: found.id, username: found.username, displayName: found.displayName };
  }

  async setPresence(
    actor: Actor,
    access: EffectiveAccess,
    accountId: string,
    input: { status: AgentPresence; reason: string },
  ) {
    requirePermission(access, 'lead.manage_assignment');
    await this.requireStaff([accountId]);
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(agentPresence)
        .where(eq(agentPresence.accountId, accountId))
        .orderBy(desc(agentPresence.createdAt), desc(agentPresence.id))
        .limit(1);
      const [row] = await tx
        .insert(agentPresence)
        .values({
          accountId,
          status: input.status,
          reason: input.reason,
          createdBy: actor.accountId,
        })
        .returning();
      await this.audit.record(
        {
          actor,
          action: 'lead.agent_presence_set',
          entityType: 'agent',
          entityId: accountId,
          before: { status: before?.status ?? 'present' },
          after: { status: input.status },
          reason: input.reason,
        },
        tx,
      );
      return { accountId, status: row?.status ?? input.status };
    });
  }

  async setCap(
    actor: Actor,
    access: EffectiveAccess,
    accountId: string,
    input: { maxOpenCases: number | null; reason: string },
  ) {
    requirePermission(access, 'lead.manage_assignment');
    await this.requireStaff([accountId]);
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(agentCaps)
        .where(eq(agentCaps.accountId, accountId))
        .orderBy(desc(agentCaps.createdAt), desc(agentCaps.id))
        .limit(1);
      await tx.insert(agentCaps).values({
        accountId,
        maxOpenCases: input.maxOpenCases,
        reason: input.reason,
        createdBy: actor.accountId,
      });
      await this.audit.record(
        {
          actor,
          action: 'lead.agent_cap_set',
          entityType: 'agent',
          entityId: accountId,
          before: { maxOpenCases: before?.maxOpenCases ?? null },
          after: { maxOpenCases: input.maxOpenCases },
          reason: input.reason,
        },
        tx,
      );
      return { accountId, maxOpenCases: input.maxOpenCases };
    });
  }

  /**
   * Target against actual for each version of a queue that assigned in [from, to): per
   * agent, the share set and the automatic assignments received (doc 05 §6).
   */
  async distribution(
    access: EffectiveAccess,
    query: { queueCode: string; from: string; to: string },
  ) {
    requirePermission(access, 'lead.read_distribution_report');
    const rows = await this.reporting.execute(sql`
      SELECT v.id AS version_id, v.city_code, v.treatment_field_code,
             to_char(v.effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective_at,
             w.account_id, w.percent,
             (SELECT count(*)::int FROM case_assignments a
              WHERE a.weight_version_id = v.id AND a.account_id = w.account_id AND a.kind = 'auto'
                AND a.created_at >= ${query.from}::timestamptz AND a.created_at < ${query.to}::timestamptz) AS received
      FROM assignment_weight_versions v
      JOIN assignment_weights w ON w.version_id = v.id
      WHERE v.queue_code = ${query.queueCode}
        AND EXISTS (SELECT 1 FROM case_assignments a WHERE a.weight_version_id = v.id
          AND a.created_at >= ${query.from}::timestamptz AND a.created_at < ${query.to}::timestamptz)
      ORDER BY v.effective_at, v.id, w.account_id
    `);
    const versions = new Map<
      string,
      {
        versionId: string;
        cityCode: string | null;
        treatmentFieldCode: string | null;
        effectiveAt: string;
        agents: {
          accountId: string;
          targetPercent: number;
          received: number;
          /** The actual share in basis points (5000 = 50%): an integer, never a float. */
          actualBasisPoints: number;
        }[];
      }
    >();
    for (const r of rows.rows) {
      const id = r['version_id'] as string;
      let v = versions.get(id);
      if (!v) {
        v = {
          versionId: id,
          cityCode: (r['city_code'] as string | null) ?? null,
          treatmentFieldCode: (r['treatment_field_code'] as string | null) ?? null,
          effectiveAt: r['effective_at'] as string,
          agents: [],
        };
        versions.set(id, v);
      }
      v.agents.push({
        accountId: r['account_id'] as string,
        targetPercent: r['percent'] as number,
        received: r['received'] as number,
        actualBasisPoints: 0,
      });
    }
    for (const v of versions.values()) {
      const total = v.agents.reduce((s, a) => s + a.received, 0);
      for (const a of v.agents) {
        a.actualBasisPoints = total === 0 ? 0 : Math.round((a.received * 10_000) / total);
      }
    }
    return [...versions.values()];
  }

  // --- helpers ----------------------------------------------------------------------------

  private async current(
    ex: Database | Parameters<Parameters<Database['transaction']>[0]>[0],
    queueCode: string,
    cityCode: string | null,
    treatmentFieldCode: string | null,
  ): Promise<SharesView | null> {
    const [version] = await ex
      .select()
      .from(assignmentWeightVersions)
      .where(
        and(
          eq(assignmentWeightVersions.queueCode, queueCode),
          cityCode === null
            ? isNull(assignmentWeightVersions.cityCode)
            : eq(assignmentWeightVersions.cityCode, cityCode),
          treatmentFieldCode === null
            ? isNull(assignmentWeightVersions.treatmentFieldCode)
            : eq(assignmentWeightVersions.treatmentFieldCode, treatmentFieldCode),
        ),
      )
      .orderBy(desc(assignmentWeightVersions.effectiveAt), desc(assignmentWeightVersions.id))
      .limit(1);
    if (!version) return null;
    const shares = await ex
      .select({ accountId: assignmentWeights.accountId, percent: assignmentWeights.percent })
      .from(assignmentWeights)
      .where(eq(assignmentWeights.versionId, version.id))
      .orderBy(asc(assignmentWeights.accountId));
    return {
      versionId: version.id,
      queueCode: version.queueCode,
      cityCode: version.cityCode,
      treatmentFieldCode: version.treatmentFieldCode,
      effectiveAt: version.effectiveAt.toISOString(),
      shares,
    };
  }

  /** Only active staff accounts take cases. */
  private async requireStaff(accountIds: string[]) {
    for (const id of accountIds) {
      const account = await this.accounts.find(id);
      if (account?.kind !== 'staff' || account.status !== 'active') {
        throw new BadRequestException({ error: 'not_an_active_staff_account', accountId: id });
      }
    }
  }
}
