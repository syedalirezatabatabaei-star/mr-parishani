import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  addJalaliMonths,
  formatJalaliDate,
  fromJalali,
  toJalali,
  type CeoDashboard,
  type DoctorDashboard,
  type PermissionCode,
  type UnitDashboard,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { REPORTING_DATABASE, type ReportingDatabase } from '../../db/reporting.module';
import { tehranDate } from './report-definition';

const iso = (v: unknown) =>
  v === null || v === undefined ? null : new Date(v as string).toISOString();
/** The overdue ratio's threshold (7.1: 30 days), as task 7-4's receivables report. */
const OVERDUE_DAYS = 30;
/** «At risk» when no warning window is set (task 7-5 decision; a display default). */
const AT_RISK_DEFAULT_MINUTES = 24 * 60;
/**
 * The doctor's rank: patients completed in this many days (doc 09 open item 7, its default;
 * TODO(decision): the client's formula).
 */
const RANK_DAYS = 90;

function need(access: EffectiveAccess, permission: PermissionCode) {
  if (!access.permissions.has(permission)) {
    throw new ForbiddenException({ error: 'permission_required', permission });
  }
}

/**
 * The dashboards (task 7-5; doc 17 §3; docs/decisions/task-7-5-decisions.md), read on the
 * reporting connection only from 7-4's views: the CEO's tiles and trend, a unit's queue and
 * agents, the doctor's rank. Money from report_ledger_daily alone; each says how fresh it is.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(REPORTING_DATABASE) private readonly reporting: ReportingDatabase,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  async ceo(access: EffectiveAccess, now = new Date()): Promise<CeoDashboard> {
    need(access, 'reporting.dashboard_ceo');
    const first = { ...toJalali(now), day: 1 };
    const months = [-5, -4, -3, -2, -1, 0].map((n) => {
      const start = addJalaliMonths(first, n);
      return {
        label: formatJalaliDate(start).slice(0, 7),
        from: tehranDate(fromJalali(start)),
        to: tehranDate(fromJalali(addJalaliMonths(start, 1))),
      };
    });
    const current = months[months.length - 1];
    const tiles = (
      await this.reporting.execute(sql`
        SELECT
          (SELECT count(DISTINCT case_id)::int FROM report_case_stages
           WHERE current_status NOT IN ('completed', 'cancelled')) AS active,
          (SELECT coalesce(sum(debit_rial), 0)::text FROM report_ledger_daily
           WHERE code = 'purse.approved' AND owner_type = 'purse' AND event_type = 'wallet.charge'
             AND day >= ${current?.from ?? ''}::date AND day < ${current?.to ?? ''}::date) AS charged,
          (SELECT coalesce(sum(debit_rial - credit_rial), 0)::text FROM report_ledger_daily
           WHERE code = 'borrower.debt' AND owner_type = 'purse') AS debt,
          (SELECT CASE WHEN sum(outstanding_rial) > 0 THEN to_char(round(100.0 *
             coalesce(sum(outstanding_rial) FILTER (WHERE status = 'overdue'
               AND days_past_due >= ${OVERDUE_DAYS}), 0) / sum(outstanding_rial), 2), 'FM9990.00')
           END FROM installment_states) AS overdue,
          (SELECT count(*)::int FROM tickets
           WHERE kind = 'complaint' AND status NOT IN ('resolved', 'closed')) AS complaints,
          (SELECT min(last) FROM (SELECT max(refreshed_at) AS last FROM report_refreshes
           WHERE view_name IN ('report_ledger_daily', 'report_case_stages')
           GROUP BY view_name) x) AS as_of
      `)
    ).rows[0];
    const trend = (
      await this.reporting.execute(sql`
        WITH m(ord, label, f, t) AS (VALUES ${sql.join(
          months.map((m, i) => sql`(${i}, ${m.label}, ${m.from}::date, ${m.to}::date)`),
          sql`, `,
        )})
        SELECT m.label,
          coalesce(sum(l.debit_rial) FILTER (WHERE l.code = 'purse.approved'
            AND l.owner_type = 'purse' AND l.event_type = 'wallet.charge'), 0)::text AS charged,
          coalesce(sum(l.credit_rial) FILTER (WHERE l.code = 'borrower.debt'
            AND l.owner_type = 'purse' AND l.event_type = 'repayment.payment_allocated'), 0)::text
            AS collected
        FROM m LEFT JOIN report_ledger_daily l ON l.day >= m.f AND l.day < m.t
          AND l.code IN ('purse.approved', 'borrower.debt')
        GROUP BY m.ord, m.label ORDER BY m.ord
      `)
    ).rows;
    return {
      activeCases: Number(tiles?.['active'] ?? 0),
      chargedThisMonthRial: (tiles?.['charged'] as string | undefined) ?? '0',
      outstandingDebtRial: (tiles?.['debt'] as string | undefined) ?? '0',
      overdueRatio: (tiles?.['overdue'] as string | null) ?? null,
      openComplaints: Number(tiles?.['complaints'] ?? 0),
      trend: trend.map((r) => ({
        month: r['label'] as string,
        chargedRial: r['charged'] as string,
        collectedRial: r['collected'] as string,
      })),
      asOf: iso(tiles?.['as_of']),
    };
  }

  /** A unit's: one who works its tickets (its role), a manager, or a read-only role (7-1). */
  async unit(access: EffectiveAccess, unit: string, now = new Date()): Promise<UnitDashboard> {
    const reads =
      access.permissions.has('ticket.read_all') ||
      access.permissions.has('ticket.assign') ||
      (access.permissions.has('ticket.work') && access.roles.includes(unit));
    if (!reads) throw new ForbiddenException({ error: 'not_your_unit' });
    const warning = (await this.config.resolve('ticket.sla_warning_minutes', {}, now)).value;
    const window = warning > 0 ? warning : AT_RISK_DEFAULT_MINUTES;
    const queues = unit === 'collection' ? [`ticket_${unit}`, 'collection'] : [`ticket_${unit}`];
    const at = now.toISOString();
    const counts = (
      await this.reporting.execute(sql`
        SELECT
          count(*) FILTER (WHERE status NOT IN ('resolved', 'closed'))::int AS open,
          count(*) FILTER (WHERE status = 'open')::int AS unassigned,
          count(*) FILTER (WHERE status NOT IN ('resolved', 'closed') AND paused_at IS NULL
            AND due_at <= ${at})::int AS overdue,
          count(*) FILTER (WHERE status NOT IN ('resolved', 'closed') AND paused_at IS NULL
            AND due_at > ${at}
            AND due_at <= ${new Date(now.getTime() + window * 60_000).toISOString()})::int AS at_risk
        FROM tickets WHERE unit = ${unit}
      `)
    ).rows[0];
    const agents = (
      await this.reporting.execute(sql`
        SELECT account_id::text AS account, queue_code AS queue,
          count(DISTINCT item_id)::int AS open
        FROM report_assignments
        WHERE open_now AND queue_code IN (${sql.join(
          queues.map((q) => sql`${q}`),
          sql`, `,
        )})
        GROUP BY account_id, queue_code ORDER BY open DESC, account_id
      `)
    ).rows;
    const today = tehranDate(now);
    const opened = (
      await this.reporting.execute(sql`
        SELECT d::date::text AS day,
          (SELECT count(*)::int FROM tickets t WHERE t.unit = ${unit}
           AND (t.created_at AT TIME ZONE 'Asia/Tehran')::date = d::date) AS tickets
        FROM generate_series(${today}::date - 13, ${today}::date, interval '1 day') d
        ORDER BY d
      `)
    ).rows;
    const fresh = (
      await this.reporting.execute(sql`
        SELECT max(refreshed_at) AS as_of FROM report_refreshes
        WHERE view_name = 'report_assignments'
      `)
    ).rows[0];
    return {
      unit,
      open: Number(counts?.['open'] ?? 0),
      unassigned: Number(counts?.['unassigned'] ?? 0),
      overdue: Number(counts?.['overdue'] ?? 0),
      atRisk: Number(counts?.['at_risk'] ?? 0),
      atRiskMinutes: window,
      agents: agents.map((r) => ({
        accountId: r['account'] as string,
        queue: r['queue'] as string,
        open: Number(r['open']),
      })),
      opened: opened.map((r) => ({ day: r['day'] as string, tickets: Number(r['tickets']) })),
      asOf: iso(fresh?.['as_of']),
    };
  }

  /** The doctor's rank in each field they work in: their own doctor nodes, or those below. */
  async doctor(access: EffectiveAccess): Promise<DoctorDashboard> {
    need(access, 'settlement.read_own');
    const paths = access.scopes.flatMap((s) =>
      s.kind === 'doctor' || s.kind === 'center' || s.kind === 'branch' ? [s.path] : [],
    );
    if (paths.length === 0) return { ranks: [] };
    const rows = (
      await this.reporting.execute(sql`
        WITH mine AS (
          SELECT id FROM org_nodes WHERE kind = 'doctor' AND (${sql.join(
            paths.map((p) => sql`path <@ ${p}::ltree`),
            sql` OR `,
          )})
        ), p AS (
          SELECT d.doctor_node_id, r.treatment_field_code AS field,
            count(DISTINCT d.case_id)::int AS patients
          FROM doctor_payables d JOIN report_purses r ON r.id = d.purse_id
          WHERE d.finalized_at >= now() - make_interval(days => ${RANK_DAYS})
          GROUP BY d.doctor_node_id, r.treatment_field_code
        ), ranked AS (
          SELECT *, rank() OVER (PARTITION BY field ORDER BY patients DESC)::int AS rank,
            count(*) OVER (PARTITION BY field)::int AS of
          FROM p
        )
        SELECT doctor_node_id::text AS node, field, patients, rank, of
        FROM ranked WHERE doctor_node_id IN (SELECT id FROM mine)
        ORDER BY field, rank
      `)
    ).rows;
    return {
      ranks: rows.map((r) => ({
        doctorNodeId: r['node'] as string,
        treatmentField: r['field'] as string,
        patients: Number(r['patients']),
        rank: Number(r['rank']),
        of: Number(r['of']),
      })),
    };
  }
}
