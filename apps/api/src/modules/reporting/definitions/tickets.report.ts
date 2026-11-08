import { ticketsReportParamsSchema } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../../common/auth/access.port';
import type { ReportDefinition } from '../report-definition';

const STATUS: Record<string, string> = {
  open: 'باز',
  assigned: 'ارجاع‌شده',
  in_progress: 'در حال بررسی',
  waiting_on_requester: 'در انتظار پاسخ ثبت‌کننده',
  resolved: 'حل‌شده',
  closed: 'بسته',
  reopened: 'بازگشایی‌شده',
};

const KIND: Record<string, string> = { ticket: 'تیکت', complaint: 'شکایت' };

const CHANNEL: Record<string, string> = {
  patient: 'بیمار',
  center: 'مرکز',
  staff: 'کارکنان برای تماس‌گیرنده',
  internal: 'داخلی',
};

/**
 * «شکایات و تیکت» (doc 17 §2; task 7-3's first report, task 7-4 adds to it): the tickets
 * opened in a range, by unit and status, and whether their deadline passed. The units one
 * works (or all, for the managers and read-only roles), as the ticket queue (task 7-1). Who
 * has a ticket only for its managers.
 */
export const ticketsReport: ReportDefinition<typeof ticketsReportParamsSchema> = {
  code: 'tickets',
  title: 'شکایات و تیکت',
  permissions: ['ticket.work', 'ticket.assign', 'ticket.read_all'],
  params: ticketsReportParamsSchema,
  views: [],
  columns: [
    { key: 'number', title: 'شماره', kind: 'int' },
    { key: 'kind', title: 'نوع', kind: 'text', labels: KIND },
    { key: 'topic', title: 'موضوع', kind: 'text' },
    { key: 'unit', title: 'واحد', kind: 'text' },
    { key: 'status', title: 'وضعیت', kind: 'text', labels: STATUS },
    { key: 'channel', title: 'ثبت از', kind: 'text', labels: CHANNEL },
    { key: 'openedAt', title: 'زمان ثبت', kind: 'datetime' },
    { key: 'dueAt', title: 'مهلت پاسخ', kind: 'datetime' },
    { key: 'resolvedAt', title: 'زمان حل', kind: 'datetime' },
    { key: 'overdue', title: 'گذشته از مهلت', kind: 'bool' },
    { key: 'assignee', title: 'کارشناس', kind: 'text', permission: 'ticket.assign' },
  ],
  scope(access: EffectiveAccess) {
    if (access.permissions.has('ticket.read_all') || access.permissions.has('ticket.assign')) {
      return sql`true`;
    }
    if (!access.permissions.has('ticket.work') || access.roles.length === 0) return sql`false`;
    return sql`t.unit IN (${sql.join(
      access.roles.map((r) => sql`${r}`),
      sql`, `,
    )})`;
  },
  statement(params, scope, range) {
    return sql`
      SELECT t.number::int AS number, t.kind, t.topic_code AS topic, t.unit, t.status,
        t.requester_channel AS channel, t.created_at AS "openedAt", t.due_at AS "dueAt",
        t.resolved_at AS "resolvedAt",
        (t.due_at IS NOT NULL AND t.paused_at IS NULL AND t.due_at <= now()
          AND t.status NOT IN ('resolved', 'closed')) AS overdue,
        t.assignee_account_id::text AS assignee
      FROM tickets t
      WHERE ${scope}
        AND ${range ? sql`t.created_at >= ${range.from.toISOString()} AND t.created_at < ${range.to.toISOString()}` : sql`true`}
        AND ${params.unit ? sql`t.unit = ${params.unit}` : sql`true`}
        AND ${params.status ? sql`t.status = ${params.status}` : sql`true`}
      ORDER BY t.created_at DESC, t.id DESC
    `;
  },
};
