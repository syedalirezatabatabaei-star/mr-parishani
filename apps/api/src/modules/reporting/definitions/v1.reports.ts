import {
  agentsReportParamsSchema,
  agingReportParamsSchema,
  CASE_STATUSES,
  creditReportParamsSchema,
  receivablesReportParamsSchema,
  salesReportParamsSchema,
  settlementReportParamsSchema,
  ticketsReportParamsSchema,
  walletReportParamsSchema,
} from '@sepehr/contracts';
import { sql, type SQL } from 'drizzle-orm';
import type { EffectiveAccess } from '../../../common/auth/access.port';
import { dayBounds, globalOnly, type ReportDefinition } from '../report-definition';

/**
 * The version-one reports (task 7-4; doc 17 §2), each metric as docs/decisions/task-7-4-
 * decisions.md defines it. Every figure of money comes from `report_ledger_daily`, the sums of
 * the ledger's own entries (principle 4); every query reads a materialized view or an indexed
 * table on the reporting connection only.
 */

const pct = (num: SQL, den: SQL) =>
  sql`CASE WHEN (${den}) > 0 THEN to_char(round(100.0 * (${num}) / (${den}), 2), 'FM9990.00') END`;

const inRange = (column: SQL, range: { from: Date; to: Date } | null) =>
  range
    ? sql`${column} >= ${range.from.toISOString()} AND ${column} < ${range.to.toISOString()}`
    : sql`true`;

/** City scopes narrow a report whose rows have a city; a global scope sees all (rule 13). */
function byCity(access: EffectiveAccess, column: SQL): SQL {
  if (access.scopes.some((s) => s.kind === 'global')) return sql`true`;
  const cities = access.scopes.flatMap((s) => (s.kind === 'city' ? [s.code] : []));
  return cities.length > 0
    ? sql`${column} IN (${sql.join(
        cities.map((c) => sql`${c}`),
        sql`, `,
      )})`
    : sql`false`;
}

const STAGE: Record<string, string> = {
  new: 'تازه',
  advising: 'مشاوره',
  appointment_booked: 'نوبت گرفته',
  examined: 'معاینه‌شده',
  proforma_issued: 'پیش‌فاکتور صادرشده',
  credit_requested: 'درخواست اعتبار',
  credit_decided: 'تصمیم اعتبار',
  contracted: 'قرارداد',
  funded: 'شارژ کیف',
  in_treatment: 'در درمان',
  completed: 'پایان‌یافته',
  cancelled: 'انصراف',
};

// --- 1. the sales funnel ----------------------------------------------------------------------

const salesFilter = (
  p: {
    channel?: string | undefined;
    treatmentField?: string | undefined;
    city?: string | undefined;
    assignee?: string | undefined;
  },
  scope: SQL,
  range: { from: Date; to: Date } | null,
) => sql`${scope}
  AND ${inRange(sql`s.case_created_at`, range)}
  AND ${p.channel ? sql`s.channel = ${p.channel}` : sql`true`}
  AND ${p.treatmentField ? sql`s.treatment_field_code = ${p.treatmentField}` : sql`true`}
  AND ${p.city ? sql`s.city_code = ${p.city}` : sql`true`}
  AND ${p.assignee ? sql`s.assignee_account_id = ${p.assignee}` : sql`true`}`;

export const salesFunnelReport: ReportDefinition<typeof salesReportParamsSchema> = {
  code: 'sales_funnel',
  title: 'قیف فروش',
  permissions: ['reporting.read_sales'],
  params: salesReportParamsSchema,
  views: ['report_case_stages'],
  columns: [
    { key: 'stage', title: 'مرحله', kind: 'text', labels: STAGE },
    { key: 'reached', title: 'رسیده', kind: 'int' },
    { key: 'conversion', title: 'نرخ تبدیل از مرحله قبل (درصد)', kind: 'text' },
    { key: 'avgHours', title: 'میانگین ساعت در مرحله', kind: 'text' },
  ],
  scope: (access) => byCity(access, sql`s.city_code`),
  statement(p, scope, range) {
    const stages = CASE_STATUSES.filter((s) => s !== 'cancelled');
    return sql`
      WITH r AS (
        SELECT s.stage, count(DISTINCT s.case_id) AS reached,
          avg(extract(epoch FROM s.left_at - s.entered_at) / 3600.0)
            FILTER (WHERE s.left_at IS NOT NULL) AS avg_hours
        FROM report_case_stages s
        WHERE ${salesFilter(p, scope, range)}
        GROUP BY s.stage
      ), o AS (
        SELECT st.stage, st.ord, coalesce(r.reached, 0)::int AS reached, r.avg_hours
        FROM unnest(ARRAY[${sql.join(
          stages.map((s) => sql`${s}`),
          sql`, `,
        )}]::text[]) WITH ORDINALITY AS st(stage, ord)
        LEFT JOIN r ON r.stage = st.stage
      )
      SELECT stage, reached,
        ${pct(sql`reached`, sql`lag(reached) OVER (ORDER BY ord)`)} AS conversion,
        to_char(round(avg_hours::numeric, 1), 'FM999990.0') AS "avgHours"
      FROM o ORDER BY ord
    `;
  },
};

export const salesAbandonmentReport: ReportDefinition<typeof salesReportParamsSchema> = {
  code: 'sales_abandonment',
  title: 'علت‌های انصراف',
  permissions: ['reporting.read_sales'],
  params: salesReportParamsSchema,
  views: ['report_case_stages'],
  columns: [
    { key: 'reason', title: 'علت', kind: 'text' },
    { key: 'cases', title: 'پرونده', kind: 'int' },
  ],
  scope: (access) => byCity(access, sql`s.city_code`),
  statement(p, scope, range) {
    return sql`
      SELECT s.abandonment_reason_code AS reason, count(DISTINCT s.case_id)::int AS cases
      FROM report_case_stages s
      WHERE ${salesFilter(p, scope, range)} AND s.abandonment_reason_code IS NOT NULL
      GROUP BY s.abandonment_reason_code
      ORDER BY cases DESC, reason
    `;
  },
};

// --- 2. credit --------------------------------------------------------------------------------

const METRIC: Record<string, string> = {
  submitted: 'پرونده‌های ورودی',
  approved: 'تأیید',
  conditional: 'مشروط',
  rejected: 'رد',
  needs_more_guarantors: 'نیاز به ضامن بیشتر',
  sla_met: 'رعایت مهلت ۲۴ ساعته',
  out_of_matrix: 'تصمیم خارج از ماتریس',
  total_debt: 'مانده بدهی کل',
  overdue_amount: 'نسبت معوق (مبلغی)',
  overdue_count: 'نسبت معوق (تعدادی)',
  collected: 'وصول‌شده در بازه',
  due: 'سررسیدشده در بازه',
  collection_rate: 'نرخ وصول',
  broken_promises: 'وعده‌های شکسته',
};

export const creditSummaryReport: ReportDefinition<typeof creditReportParamsSchema> = {
  code: 'credit_summary',
  title: 'اعتبار',
  permissions: ['reporting.read_credit'],
  params: creditReportParamsSchema,
  views: ['report_credit_applications'],
  columns: [
    { key: 'metric', title: 'شاخص', kind: 'text', labels: METRIC },
    { key: 'count', title: 'شمار', kind: 'int' },
    { key: 'percent', title: 'درصد', kind: 'text' },
  ],
  scope: globalOnly,
  statement(_p, scope, range) {
    return sql`
      WITH a AS (
        SELECT * FROM report_credit_applications c
        WHERE ${scope} AND ${inRange(sql`c.submitted_at`, range)}
      ), n AS (
        SELECT count(*)::int AS submitted,
          count(*) FILTER (WHERE final_outcome IS NOT NULL)::int AS decided,
          count(*) FILTER (WHERE final_outcome = 'approved')::int AS approved,
          count(*) FILTER (WHERE final_outcome = 'conditional')::int AS conditional,
          count(*) FILTER (WHERE final_outcome = 'rejected')::int AS rejected,
          count(*) FILTER (WHERE final_outcome = 'needs_more_guarantors')::int AS more,
          count(*) FILTER (WHERE sla_due_at IS NOT NULL)::int AS with_sla,
          count(*) FILTER (WHERE sla_due_at IS NOT NULL AND sla_breached_at IS NULL)::int AS sla_met,
          count(*) FILTER (WHERE out_of_matrix)::int AS out_of_matrix
        FROM a
      )
      SELECT m.metric, m.count, m.percent FROM n, LATERAL (VALUES
        (1, 'submitted', n.submitted, NULL::text),
        (2, 'approved', n.approved, ${pct(sql`n.approved`, sql`n.decided`)}),
        (3, 'conditional', n.conditional, ${pct(sql`n.conditional`, sql`n.decided`)}),
        (4, 'rejected', n.rejected, ${pct(sql`n.rejected`, sql`n.decided`)}),
        (5, 'needs_more_guarantors', n.more, ${pct(sql`n.more`, sql`n.decided`)}),
        (6, 'sla_met', n.sla_met, ${pct(sql`n.sla_met`, sql`n.with_sla`)}),
        (7, 'out_of_matrix', n.out_of_matrix, ${pct(sql`n.out_of_matrix`, sql`n.decided`)})
      ) AS m(ord, metric, count, percent)
      ORDER BY m.ord
    `;
  },
};

const GRADE: Record<string, string> = { alef: 'الف', be: 'ب', jim: 'ج', dal: 'د' };

export const creditGradesReport: ReportDefinition<typeof creditReportParamsSchema> = {
  code: 'credit_grades',
  title: 'توزیع رتبه',
  permissions: ['reporting.read_credit'],
  params: creditReportParamsSchema,
  views: ['report_credit_applications'],
  columns: [
    { key: 'grade', title: 'رتبه', kind: 'text', labels: GRADE },
    { key: 'applications', title: 'پرونده', kind: 'int' },
  ],
  scope: globalOnly,
  statement(_p, scope, range) {
    return sql`
      SELECT coalesce(c.grade, 'unscored') AS grade, count(*)::int AS applications
      FROM report_credit_applications c
      WHERE ${scope} AND ${inRange(sql`c.submitted_at`, range)}
      GROUP BY coalesce(c.grade, 'unscored')
      ORDER BY grade
    `;
  },
};

// --- 3. the centers' settlement (test 7) ------------------------------------------------------

export const settlementCentersReport: ReportDefinition<typeof settlementReportParamsSchema> = {
  code: 'settlement_centers',
  title: 'تسویه مراکز',
  permissions: ['reporting.read_settlement'],
  params: settlementReportParamsSchema,
  views: ['report_ledger_daily'],
  columns: [
    { key: 'doctorNodeId', title: 'شناسه پزشک', kind: 'text' },
    { key: 'doctor', title: 'پزشک', kind: 'text' },
    { key: 'accrued', title: 'بدهی ایجادشده', kind: 'rial' },
    { key: 'paid', title: 'پرداخت‌شده', kind: 'rial' },
    { key: 'offset', title: 'تهاتر کارمزد', kind: 'rial' },
    { key: 'reversed', title: 'برگشت‌خورده', kind: 'rial' },
    { key: 'fees', title: 'کارمزد', kind: 'rial' },
    { key: 'payableBalance', title: 'مانده بدهی تا پایان بازه', kind: 'rial' },
    { key: 'feeBalance', title: 'مانده کارمزد تا پایان بازه', kind: 'rial' },
    { key: 'negative', title: 'مانده منفی', kind: 'bool' },
    { key: 'dueNow', title: 'اقلام سررسیدشده (اکنون)', kind: 'rial' },
    { key: 'futureNow', title: 'اقلام آینده (اکنون)', kind: 'rial' },
    { key: 'heldNow', title: 'اقلام معلق (اکنون)', kind: 'rial' },
  ],
  scope: globalOnly,
  statement(p, scope, range) {
    const d = dayBounds(range);
    return sql`
      WITH l AS (
        SELECT owner_id, code, event_type, reversed_event_type, day, debit_rial, credit_rial,
          day >= ${d.from}::date AS in_range
        FROM report_ledger_daily
        WHERE owner_type = 'doctor' AND code IN ('doctor.payable', 'doctor.fee_receivable')
          AND day < ${d.to}::date
          AND ${p.doctorNodeId ? sql`owner_id = ${p.doctorNodeId}` : sql`true`}
      ), g AS (
        SELECT owner_id,
          sum(credit_rial) FILTER (WHERE in_range AND code = 'doctor.payable') AS accrued,
          sum(debit_rial) FILTER (WHERE in_range AND code = 'doctor.payable'
            AND event_type = 'settlement.payout_paid') AS paid,
          sum(debit_rial) FILTER (WHERE in_range AND code = 'doctor.payable'
            AND event_type = 'settlement.statement_offset') AS offset_rial,
          sum(debit_rial) FILTER (WHERE in_range AND code = 'doctor.payable'
            AND reversed_event_type IS NOT NULL) AS reversed,
          sum(debit_rial) FILTER (WHERE in_range AND code = 'doctor.fee_receivable') AS fees,
          sum(credit_rial - debit_rial) FILTER (WHERE code = 'doctor.payable') AS payable_balance,
          sum(debit_rial - credit_rial) FILTER (WHERE code = 'doctor.fee_receivable') AS fee_balance
        FROM l GROUP BY owner_id
      )
      SELECT g.owner_id::text AS "doctorNodeId", n.name AS doctor,
        coalesce(g.accrued, 0)::text AS accrued, coalesce(g.paid, 0)::text AS paid,
        coalesce(g.offset_rial, 0)::text AS "offset", coalesce(g.reversed, 0)::text AS reversed,
        coalesce(g.fees, 0)::text AS fees,
        coalesce(g.payable_balance, 0)::text AS "payableBalance",
        coalesce(g.fee_balance, 0)::text AS "feeBalance",
        coalesce(g.payable_balance, 0) - coalesce(g.fee_balance, 0) < 0 AS negative,
        coalesce((SELECT sum(x.amount_rial) FROM doctor_payables x
                  WHERE x.doctor_node_id = g.owner_id AND x.status = 'due'), 0)::text AS "dueNow",
        coalesce((SELECT sum(x.amount_rial) FROM doctor_payables x
                  WHERE x.doctor_node_id = g.owner_id AND x.status = 'accrued'), 0)::text
          AS "futureNow",
        coalesce((SELECT sum(x.amount_rial) FROM doctor_payables x
                  WHERE x.doctor_node_id = g.owner_id AND x.status = 'on_hold'), 0)::text
          AS "heldNow"
      FROM g LEFT JOIN org_nodes n ON n.id = g.owner_id
      WHERE ${scope}
      ORDER BY n.name, g.owner_id
    `;
  },
};

// --- 4. receivables (test 7) ------------------------------------------------------------------

export const receivablesSummaryReport: ReportDefinition<typeof receivablesReportParamsSchema> = {
  code: 'receivables_summary',
  title: 'مطالبات',
  permissions: ['reporting.read_receivables'],
  params: receivablesReportParamsSchema,
  views: ['report_ledger_daily'],
  columns: [
    { key: 'metric', title: 'شاخص', kind: 'text', labels: METRIC },
    { key: 'amount', title: 'مبلغ', kind: 'rial' },
    { key: 'count', title: 'شمار', kind: 'int' },
    { key: 'percent', title: 'درصد', kind: 'text' },
  ],
  scope: globalOnly,
  statement(p, scope, range) {
    const d = dayBounds(range);
    return sql`
      WITH debt AS (
        SELECT
          sum(debit_rial - credit_rial) AS total,
          sum(credit_rial) FILTER (WHERE event_type = 'repayment.payment_allocated'
            AND day >= ${d.from}::date AND day < ${d.to}::date) AS collected
        FROM report_ledger_daily WHERE code = 'borrower.debt' AND owner_type = 'purse'
      ), inst AS (
        SELECT
          sum(outstanding_rial) AS outstanding,
          sum(outstanding_rial) FILTER (WHERE status = 'overdue'
            AND days_past_due >= ${p.thresholdDays}) AS overdue,
          count(DISTINCT case_id) FILTER (WHERE outstanding_rial > 0) AS loans,
          count(DISTINCT case_id) FILTER (WHERE status = 'overdue'
            AND days_past_due >= ${p.thresholdDays}) AS overdue_loans,
          sum(amount_rial) FILTER (WHERE due_on >= ${d.from}::date AND due_on < ${d.to}::date)
            AS due
        FROM installment_states
      ), promises AS (
        SELECT count(*)::int AS broken FROM payment_promises
        WHERE status = 'broken' AND ${inRange(sql`evaluated_at`, range)}
      )
      SELECT m.metric, m.amount, m.count, m.percent
      FROM debt, inst, promises, LATERAL (VALUES
        (1, 'total_debt', coalesce(debt.total, 0)::text, NULL::int, NULL::text),
        (2, 'overdue_amount', coalesce(inst.overdue, 0)::text, NULL::int,
          ${pct(sql`coalesce(inst.overdue, 0)`, sql`coalesce(inst.outstanding, 0)`)}),
        (3, 'overdue_count', NULL::text, inst.overdue_loans::int,
          ${pct(sql`inst.overdue_loans`, sql`inst.loans`)}),
        (4, 'collected', coalesce(debt.collected, 0)::text, NULL::int, NULL::text),
        (5, 'due', coalesce(inst.due, 0)::text, NULL::int, NULL::text),
        (6, 'collection_rate', NULL::text, NULL::int,
          ${pct(sql`coalesce(debt.collected, 0)`, sql`coalesce(inst.due, 0)`)}),
        (7, 'broken_promises', NULL::text, promises.broken, NULL::text)
      ) AS m(ord, metric, amount, count, percent)
      WHERE ${scope}
      ORDER BY m.ord
    `;
  },
};

export const receivablesAgingReport: ReportDefinition<typeof agingReportParamsSchema> = {
  code: 'receivables_aging',
  title: 'سنی‌سازی معوقات',
  permissions: ['reporting.read_receivables'],
  params: agingReportParamsSchema,
  views: [],
  columns: [
    { key: 'bucket', title: 'دسته (روز معوق)', kind: 'text' },
    { key: 'loans', title: 'وام', kind: 'int' },
    { key: 'outstanding', title: 'مانده اقساط', kind: 'rial' },
    { key: 'asOfDay', title: 'وضعیت اقساط تا روز', kind: 'date' },
  ],
  scope: globalOnly,
  statement(p, scope) {
    const b = p.buckets;
    const cases = b.map((first, i) => sql`WHEN d >= ${first} THEN ${i + 1}`).reverse();
    const labels = sql.join(
      [
        sql`'جاری'`,
        ...b.map((first, i) => {
          const next = b[i + 1];
          return next
            ? sql`${`${String(first)} تا ${String(next - 1)}`}`
            : sql`${`${String(first)}+`}`;
        }),
      ],
      sql`, `,
    );
    return sql`
      WITH per AS (
        SELECT case_id, max(days_past_due) FILTER (WHERE status = 'overdue') AS d,
          sum(outstanding_rial) AS o, max(as_of) AS as_of
        FROM installment_states GROUP BY case_id HAVING sum(outstanding_rial) > 0
      ), x AS (
        SELECT CASE ${sql.join(cases, sql` `)} ELSE 0 END AS n, o, as_of FROM per
      )
      SELECT (ARRAY[${labels}]::text[])[x.n + 1] AS bucket, count(*)::int AS loans,
        sum(x.o)::text AS outstanding, max(x.as_of)::text AS "asOfDay"
      FROM x WHERE ${scope}
      GROUP BY x.n ORDER BY x.n
    `;
  },
};

// --- 5. tickets, summed ----------------------------------------------------------------------

export const ticketsSummaryReport: ReportDefinition<typeof ticketsReportParamsSchema> = {
  code: 'tickets_summary',
  title: 'شکایات و تیکت (خلاصه)',
  permissions: ['ticket.work', 'ticket.assign', 'ticket.read_all'],
  params: ticketsReportParamsSchema,
  views: [],
  columns: [
    { key: 'unit', title: 'واحد', kind: 'text' },
    { key: 'topic', title: 'موضوع', kind: 'text' },
    { key: 'total', title: 'کل', kind: 'int' },
    { key: 'open', title: 'باز', kind: 'int' },
    { key: 'resolved', title: 'حل‌شده', kind: 'int' },
    { key: 'breached', title: 'گذشته از مهلت', kind: 'int' },
    { key: 'complaints', title: 'شکایت', kind: 'int' },
    { key: 'withinDeadline', title: 'رعایت مهلت (درصد)', kind: 'text' },
  ],
  scope: (access) =>
    access.permissions.has('ticket.read_all') || access.permissions.has('ticket.assign')
      ? sql`true`
      : access.permissions.has('ticket.work') && access.roles.length > 0
        ? sql`t.unit IN (${sql.join(
            access.roles.map((r) => sql`${r}`),
            sql`, `,
          )})`
        : sql`false`,
  statement(p, scope, range) {
    return sql`
      WITH t AS (
        SELECT t.id, t.unit, t.topic_code, t.kind, t.status, t.response_hours,
          EXISTS (SELECT 1 FROM ticket_events e
                  WHERE e.ticket_id = t.id AND e.kind = 'sla_breached') AS breached
        FROM tickets t
        WHERE ${scope} AND ${inRange(sql`t.created_at`, range)}
          AND ${p.unit ? sql`t.unit = ${p.unit}` : sql`true`}
          AND ${p.status ? sql`t.status = ${p.status}` : sql`true`}
      )
      SELECT unit, topic_code AS topic, count(*)::int AS total,
        count(*) FILTER (WHERE status NOT IN ('resolved', 'closed'))::int AS open,
        count(*) FILTER (WHERE status IN ('resolved', 'closed'))::int AS resolved,
        count(*) FILTER (WHERE breached)::int AS breached,
        count(*) FILTER (WHERE kind = 'complaint')::int AS complaints,
        ${pct(
          sql`count(*) FILTER (WHERE status IN ('resolved', 'closed') AND response_hours > 0
                AND NOT breached)`,
          sql`count(*) FILTER (WHERE status IN ('resolved', 'closed') AND response_hours > 0)`,
        )} AS "withinDeadline"
      FROM t GROUP BY unit, topic_code ORDER BY unit, topic_code
    `;
  },
};

// --- 6. the agents' performance --------------------------------------------------------------

export const agentsPerformanceReport: ReportDefinition<typeof agentsReportParamsSchema> = {
  code: 'agents_performance',
  title: 'عملکرد کارشناسان',
  permissions: ['reporting.read_agents'],
  params: agentsReportParamsSchema,
  views: ['report_assignments'],
  columns: [
    { key: 'queue', title: 'صف', kind: 'text' },
    { key: 'accountId', title: 'کارشناس', kind: 'text' },
    { key: 'target', title: 'درصد تعیین‌شده', kind: 'int' },
    { key: 'actual', title: 'درصد واقعی', kind: 'text' },
    { key: 'autoAssigned', title: 'تخصیص خودکار', kind: 'int' },
    { key: 'manualAssigned', title: 'تخصیص دستی', kind: 'int' },
    { key: 'workload', title: 'بار کاری (اکنون)', kind: 'int' },
    { key: 'avgResponseHours', title: 'میانگین ساعت پاسخ', kind: 'text' },
  ],
  scope: globalOnly,
  statement(p, scope, range) {
    const queue = p.queue ? sql`queue_code = ${p.queue}` : sql`true`;
    return sql`
      WITH a AS (
        SELECT * FROM report_assignments
        WHERE ${inRange(sql`assigned_at`, range)} AND ${queue}
      ), totals AS (
        SELECT queue_code, count(*) FILTER (WHERE auto) AS auto FROM a GROUP BY queue_code
      ), versions AS (
        SELECT DISTINCT ON (queue_code) id, queue_code FROM assignment_weight_versions
        WHERE city_code IS NULL AND treatment_field_code IS NULL AND effective_at <= now()
          AND ${queue}
        ORDER BY queue_code, effective_at DESC, created_at DESC
      ), targets AS (
        SELECT v.queue_code, w.account_id, w.percent
        FROM versions v JOIN assignment_weights w ON w.version_id = v.id
      ), agents AS (
        SELECT queue_code, account_id FROM a UNION SELECT queue_code, account_id FROM targets
      ), load AS (
        SELECT queue_code, account_id, count(DISTINCT item_id)::int AS open
        FROM report_assignments WHERE open_now AND ${queue}
        GROUP BY queue_code, account_id
      )
      SELECT g.queue_code AS queue, g.account_id::text AS "accountId", t.percent AS target,
        ${pct(sql`count(a.id) FILTER (WHERE a.auto)`, sql`max(tot.auto)`)} AS actual,
        count(a.id) FILTER (WHERE a.auto)::int AS "autoAssigned",
        count(a.id) FILTER (WHERE NOT a.auto)::int AS "manualAssigned",
        coalesce(max(l.open), 0)::int AS workload,
        to_char(round((avg(extract(epoch FROM a.first_response_at - a.assigned_at) / 3600.0)
          FILTER (WHERE a.first_response_at IS NOT NULL))::numeric, 1), 'FM999990.0')
          AS "avgResponseHours"
      FROM agents g
      LEFT JOIN a ON a.queue_code = g.queue_code AND a.account_id = g.account_id
      LEFT JOIN totals tot ON tot.queue_code = g.queue_code
      LEFT JOIN targets t ON t.queue_code = g.queue_code AND t.account_id = g.account_id
      LEFT JOIN load l ON l.queue_code = g.queue_code AND l.account_id = g.account_id
      WHERE ${scope}
      GROUP BY g.queue_code, g.account_id, t.percent
      ORDER BY g.queue_code, g.account_id
    `;
  },
};

// --- 7. the credit purses' use ----------------------------------------------------------------

export const walletUsageReport: ReportDefinition<typeof walletReportParamsSchema> = {
  code: 'wallet_usage',
  title: 'کیف اعتبار',
  permissions: ['reporting.read_wallet'],
  params: walletReportParamsSchema,
  views: ['report_ledger_daily', 'report_purses', 'report_centers'],
  columns: [
    { key: 'centerNodeId', title: 'شناسه مرکز', kind: 'text' },
    { key: 'center', title: 'مرکز', kind: 'text' },
    // The field filter of doc 04 §4: only for holders of access.view_treatment.
    { key: 'treatmentField', title: 'فیلد درمان', kind: 'text' },
    { key: 'purses', title: 'کیف', kind: 'int' },
    { key: 'charged', title: 'شارژشده', kind: 'rial' },
    { key: 'consumed', title: 'مصرف‌شده', kind: 'rial' },
    { key: 'remaining', title: 'مانده تا پایان بازه', kind: 'rial' },
    { key: 'ratio', title: 'نسبت مصرف (درصد)', kind: 'text' },
  ],
  scope: globalOnly,
  statement(p, scope, range) {
    const d = dayBounds(range);
    return sql`
      WITH l AS (
        SELECT owner_id, code, event_type, reversed_event_type, debit_rial, credit_rial,
          day >= ${d.from}::date AS in_range
        FROM report_ledger_daily
        WHERE owner_type = 'purse' AND day < ${d.to}::date
          AND code IN ('purse.approved', 'purse.available', 'purse.reserved',
            'purse.consumed_pending')
      ), g AS (
        SELECT p.center_node_id, p.treatment_field_code, count(DISTINCT p.id)::int AS purses,
          sum(l.debit_rial) FILTER (WHERE l.in_range AND l.code = 'purse.approved'
            AND l.event_type = 'wallet.charge') AS charged,
          coalesce(sum(l.debit_rial) FILTER (WHERE l.in_range AND l.code = 'purse.consumed_pending'
            AND l.event_type = 'wallet.finalize'), 0)
          - coalesce(sum(l.credit_rial) FILTER (WHERE l.in_range
            AND l.code = 'purse.consumed_pending' AND l.reversed_event_type = 'wallet.finalize'), 0)
            AS consumed,
          sum(l.credit_rial - l.debit_rial) FILTER (WHERE l.code IN ('purse.available',
            'purse.reserved', 'purse.consumed_pending')) AS remaining
        FROM report_purses p JOIN l ON l.owner_id = p.id
        WHERE ${p.centerNodeId ? sql`p.center_node_id = ${p.centerNodeId}` : sql`true`}
        GROUP BY p.center_node_id, p.treatment_field_code
      )
      SELECT g.center_node_id::text AS "centerNodeId", coalesce(c.name, n.name) AS center,
        g.treatment_field_code AS "treatmentField", g.purses,
        coalesce(g.charged, 0)::text AS charged, g.consumed::text AS consumed,
        coalesce(g.remaining, 0)::text AS remaining,
        ${pct(sql`g.consumed`, sql`coalesce(g.charged, 0)`)} AS ratio
      -- A purse's center is the catalog center's id, or a private practice's node (0072).
      FROM g LEFT JOIN report_centers c ON c.id = g.center_node_id
      LEFT JOIN org_nodes n ON n.id = g.center_node_id
      WHERE ${scope}
      ORDER BY center, g.treatment_field_code
    `;
  },
};

export const V1_REPORTS = [
  salesFunnelReport,
  salesAbandonmentReport,
  creditSummaryReport,
  creditGradesReport,
  settlementCentersReport,
  receivablesSummaryReport,
  receivablesAgingReport,
  ticketsSummaryReport,
  agentsPerformanceReport,
  walletUsageReport,
] as const;
