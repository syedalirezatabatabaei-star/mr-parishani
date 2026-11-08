import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  dayRangeSchema,
  formatJalaliDate,
  gregorianToJalali,
  type ExportFormat,
  type MoneyUnit,
  type PermissionCode,
  type ReportExport,
  type ReportResult,
  type SavedFilter,
} from '@sepehr/contracts';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { ACCESS_PORT, type AccessPort, type EffectiveAccess } from '../../common/auth/access.port';
import { ACCOUNT_DIRECTORY, type AccountDirectory } from '../../common/auth/account-directory.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { OUTBOX, type OutboxPort } from '../../common/events/outbox.port';
import { PDF_RENDERER, type PdfRenderer } from '../../common/pdf/pdf-renderer.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { DATABASE, type Database } from '../../db/database.module';
import { REPORTING_DATABASE, type ReportingDatabase } from '../../db/reporting.module';
import { storageUnavailable } from '../../infra/s3-storage';
import {
  columnView,
  mask,
  rangeOf,
  visibleColumns,
  type RawCell,
  type RawRow,
  type ReportColumnDefinition,
  type ReportDefinition,
} from './report-definition';
import { csvOf, pdfHtml, type FileRow } from './report-files';
import { ReportRegistry } from './report-registry';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_ROWS = 500;
const LINK_SECONDS = 60;
const BATCH = 5;
const iso = (v: unknown) => new Date(v as string).toISOString();
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(v));
const notFound = () => new NotFoundException({ error: 'report_not_found' });

/** The views the reports read (0066), refreshed by the worker. */
export const REPORT_VIEWS = [
  'report_ledger_daily',
  'report_case_stages',
  'report_credit_applications',
  'report_assignments',
  'report_purses',
  'report_centers',
] as const;

/** A report's parameter names (task 7-7): which of the page's filters it takes. */
function paramNames(d: ReportDefinition): string[] {
  return d.params instanceof z.ZodObject ? Object.keys(d.params.shape) : [];
}

/** Ends an EXPLAIN's transaction by rolling it back. */
class ExplainDone extends Error {}

function need(access: EffectiveAccess, permission: PermissionCode) {
  if (!access.permissions.has(permission)) {
    throw new ForbiddenException({ error: 'permission_required', permission });
  }
}

/** A raw cell as the page shows it (JSON): rials and counts as digits, days, instants. */
function cellOf(c: ReportColumnDefinition, v: RawCell | undefined): FileRow[string] {
  if (v === null || v === undefined) return null;
  if (c.kind === 'bool') return Boolean(v);
  if (c.kind === 'int') return Number(v);
  if (c.kind === 'rial') return typeof v === 'bigint' ? v.toString() : String(v);
  if (c.kind === 'date') {
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  }
  if (c.kind === 'datetime') return v instanceof Date ? v.toISOString() : iso(v);
  const text = String(v);
  const label = c.labels?.[text] ?? text;
  return c.sensitive ? mask(label) : label;
}

interface Computed {
  definition: ReportDefinition;
  columns: ReportColumnDefinition[];
  rows: FileRow[];
  applied: Record<string, unknown>;
}

interface ExportRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  account_name: string;
  report_code: string;
  params: Record<string, unknown>;
  format: ExportFormat;
  money_unit: MoneyUnit;
  sensitive: boolean;
  status: ReportExport['status'];
  row_count: number | null;
  object_key: string | null;
  created_at: string;
  finished_at: string | null;
}

/**
 * Reports and exports (task 7-3; doc 17 §2, §4, §5; docs/decisions/task-7-3-decisions.md).
 * Every report query runs on the read-only reporting connection only (ADR-012; test 6); the
 * operational database is written for the record of exports and saved filters alone. What the
 * caller sees is decided once, here: the report's permission and scope, the columns they may
 * see (permission, and the API's field filter, doc 04 §4), encrypted fields masked. An export
 * is made of exactly that (test 5), recorded (test 9), in the background above the threshold
 * or as a PDF; the full value of an encrypted field only with reporting.export_sensitive and
 * a reason.
 */
@Injectable()
export class ReportService {
  constructor(
    @Inject(REPORTING_DATABASE) private readonly reporting: ReportingDatabase,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly registry: ReportRegistry,
    // The API and the worker provide these each in their own way; resolved when first used.
    private readonly moduleRef: ModuleRef,
  ) {}

  private get accounts(): AccountDirectory {
    return this.moduleRef.get<AccountDirectory>(ACCOUNT_DIRECTORY, { strict: false });
  }

  private get accessPort(): AccessPort {
    return this.moduleRef.get<AccessPort>(ACCESS_PORT, { strict: false });
  }

  /** The worker's Chromium (ADR-033); PDFs are made there only. */
  private get pdf(): PdfRenderer {
    return this.moduleRef.get<PdfRenderer>(PDF_RENDERER, { strict: false });
  }

  // --- reports ------------------------------------------------------------------------------

  /** The reports the caller may run, with the columns they would see. */
  list(access: EffectiveAccess) {
    need(access, 'reporting.run');
    return this.registry
      .all()
      .filter((d) => this.allowed(access, d))
      .map((d) => ({
        code: d.code,
        title: d.title,
        columns: visibleColumns(d, access).map(columnView),
        params: paramNames(d),
      }));
  }

  async run(
    access: EffectiveAccess,
    code: string,
    params: Record<string, unknown>,
    now = new Date(),
  ): Promise<ReportResult> {
    const computed = await this.compute(access, code, params, now, false);
    return {
      code: computed.definition.code,
      title: computed.definition.title,
      columns: computed.columns.map(columnView),
      rows: computed.rows.slice(0, PAGE_ROWS),
      total: computed.rows.length,
      limit: PAGE_ROWS,
      applied: computed.applied,
      asOf: await this.asOf(computed.definition),
    };
  }

  private allowed(access: EffectiveAccess, d: ReportDefinition): boolean {
    return (
      access.permissions.has('reporting.run') &&
      d.permissions.some((p) => access.permissions.has(p))
    );
  }

  /** The rows and columns the caller sees; `reveal` only for an export allowed to. */
  private async compute(
    access: EffectiveAccess,
    code: string,
    raw: Record<string, unknown>,
    now: Date,
    reveal: boolean,
  ): Promise<Computed> {
    need(access, 'reporting.run');
    const definition = this.registry.get(code);
    if (!definition || !this.allowed(access, definition)) throw notFound();
    const parsed = definition.params.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({ error: 'invalid_params', issues: parsed.error.issues });
    }
    const params = parsed.data as Record<string, unknown>;
    const range = dayRangeSchema.safeParse(params['range']);
    const concrete = range.success ? rangeOf(range.data, now) : null;
    const rows = (
      await this.reporting.execute(definition.statement(params, definition.scope(access), concrete))
    ).rows as RawRow[];
    const whole = reveal && definition.reveal ? await definition.reveal(rows) : null;
    const columns = visibleColumns(definition, access);
    const out = rows.map((row, i) => {
      const cells: FileRow = {};
      for (const c of columns) {
        if (c.sensitive && whole) {
          const v = whole[i]?.[c.key];
          cells[c.key] = v === null || v === undefined ? null : String(v);
        } else {
          cells[c.key] = cellOf(c, row[c.key]);
        }
      }
      return cells;
    });
    const applied = { ...params };
    if (concrete)
      applied['range'] = {
        ...range.data,
        from: concrete.from.toISOString(),
        to: concrete.to.toISOString(),
      };
    return { definition, columns, rows: out, applied };
  }

  /**
   * Task 7-4: how fresh a report is, the oldest last refresh of the views it reads (on the
   * reporting connection); null for a report of plain tables.
   */
  private async asOf(definition: ReportDefinition): Promise<string | null> {
    if (definition.views.length === 0) return null;
    const row = (
      await this.reporting.execute(sql`
        SELECT min(last) AS as_of FROM (
          SELECT max(refreshed_at) AS last FROM report_refreshes
          WHERE view_name IN (${sql.join(
            definition.views.map((v) => sql`${v}`),
            sql`, `,
          )})
          GROUP BY view_name
        ) x
      `)
    ).rows[0];
    return isoOrNull(row?.['as_of']);
  }

  /**
   * Task 7-7: every ticket topic's name, active or not (old rows keep their code), for the
   * report page's display layer. Names only; the configuration is read through its port.
   */
  async topicNames(access: EffectiveAccess): Promise<{ code: string; title: string }[]> {
    need(access, 'reporting.run');
    const topics = (await this.config.resolve('ticket.topics')).value;
    return topics.map((t) => ({ code: t.code, title: t.title }));
  }

  /**
   * Task 7-4's acceptance: the plan of a report's own query as it runs, on the reporting
   * connection. With `noSeqScan`, the planner is told to avoid sequential scans (for tables too
   * small to show their indexes otherwise); read only, in a transaction rolled back.
   */
  async explain(
    access: EffectiveAccess,
    code: string,
    raw: Record<string, unknown>,
    noSeqScan = false,
    now = new Date(),
  ): Promise<string> {
    need(access, 'reporting.run');
    const definition = this.registry.get(code);
    if (!definition || !this.allowed(access, definition)) throw notFound();
    const params = definition.params.parse(raw) as Record<string, unknown>;
    const range = dayRangeSchema.safeParse(params['range']);
    const statement = definition.statement(
      params,
      definition.scope(access),
      range.success ? rangeOf(range.data, now) : null,
    );
    let plan = '';
    await this.reporting
      .transaction(async (tx) => {
        if (noSeqScan) await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const rows = (await tx.execute(sql`EXPLAIN ${statement}`)).rows;
        plan = rows.map((r) => String(r['QUERY PLAN'])).join('\n');
        throw new ExplainDone();
      })
      .catch((error: unknown) => {
        if (!(error instanceof ExplainDone)) throw error;
      });
    return plan;
  }

  /**
   * The worker (every fifteen minutes; 7.6): the reports' materialized views refreshed without
   * blocking their readers, each refresh recorded (task 7-4).
   */
  async refreshViews(now = new Date()): Promise<string[]> {
    const done: string[] = [];
    for (const view of REPORT_VIEWS) {
      const started = Date.now();
      await this.db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY "${view}"`));
      await this.db.execute(sql`
        INSERT INTO report_refreshes (view_name, refreshed_at, duration_ms)
        VALUES (${view}, ${now.toISOString()}, ${Date.now() - started})
      `);
      done.push(view);
    }
    return done;
  }

  // --- exports ------------------------------------------------------------------------------

  /**
   * An export of exactly what the page shows, recorded (test 9): a CSV within the threshold
   * made now, ready at once; a larger one, or a PDF, queued for the worker.
   */
  async export(
    actor: Actor,
    access: EffectiveAccess,
    code: string,
    input: {
      params: Record<string, unknown>;
      format: ExportFormat;
      moneyUnit: MoneyUnit;
      sensitive?: { reason: string } | undefined;
    },
    now = new Date(),
  ): Promise<ReportExport> {
    if (input.sensitive) need(access, 'reporting.export_sensitive');
    const sensitive = input.sensitive !== undefined;
    // Validated (and allowed) before anything is recorded.
    const computed = await this.compute(access, code, input.params, now, sensitive);
    if (!this.storage.configured) throw storageUnavailable();
    const threshold = (await this.config.resolve('reporting.async_export_rows', {}, now)).value;
    const who = (await this.accounts.nameOf?.(access.accountId)) ?? access.accountId;
    const now_ = input.format === 'csv' && computed.rows.length <= threshold;
    const id = (await this.db.execute(sql`SELECT uuidv7() AS id`)).rows[0]?.['id'] as string;
    let key: string | null = null;
    if (now_) {
      key = `reports/${id}.csv`;
      await this.storage.put(
        'private',
        key,
        csvOf(computed.columns, computed.rows, input.moneyUnit),
        'text/csv; charset=utf-8',
      );
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO report_exports (id, account_id, account_name, report_code, params, format,
          money_unit, sensitive, reason, status, row_count, object_key, created_at, finished_at)
        VALUES (${id}, ${access.accountId}, ${who}, ${code}, ${JSON.stringify(input.params)}::jsonb,
          ${input.format}, ${input.moneyUnit}, ${sensitive}, ${input.sensitive?.reason ?? null},
          ${now_ ? 'ready' : 'queued'}, ${now_ ? computed.rows.length : null}, ${key},
          ${now.toISOString()}, ${now_ ? now.toISOString() : null})
      `);
      await this.audit.record(
        {
          actor,
          action: 'report.export_requested',
          entityType: 'report_export',
          entityId: id,
          after: {
            reportCode: code,
            format: input.format,
            rows: computed.rows.length,
            sensitive,
            params: input.params,
          },
          reason: input.sensitive?.reason ?? null,
        },
        tx,
      );
      if (now_) await this.exported(tx, id, code, input.format, computed.rows.length, sensitive);
    });
    return this.exportView(await this.exportRow(id));
  }

  /** The caller's exports, newest first: the panel's notice of what is ready. */
  async exports(access: EffectiveAccess): Promise<ReportExport[]> {
    need(access, 'reporting.run');
    const rows = (
      await this.db.execute(sql`
        SELECT * FROM report_exports WHERE account_id = ${access.accountId}
        ORDER BY created_at DESC, id DESC LIMIT 100
      `)
    ).rows as ExportRow[];
    return rows.map((r) => this.exportView(r));
  }

  /** A short-lived link to one's own ready export (rule 28); another's does not exist. */
  async exportLink(
    access: EffectiveAccess,
    id: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    need(access, 'reporting.run');
    const row = UUID.test(id) ? await this.exportRow(id) : null;
    if (!row || row.account_id !== access.accountId) {
      throw new NotFoundException({ error: 'export_not_found' });
    }
    if (row.status !== 'ready' || !row.object_key) {
      throw new ConflictException({ error: 'export_not_ready', status: row.status });
    }
    return {
      url: await this.storage.signedUrl(row.object_key, LINK_SECONDS),
      expiresInSeconds: LINK_SECONDS,
    };
  }

  /**
   * The worker (every ten seconds): queued exports made, each with its requester's access as it
   * is now, and stored; a failure recorded, never retried silently.
   */
  async processQueued(
    now = new Date(),
    // The worker's Chromium; a test passes its own, as the contract printer's tests do.
    renderer: PdfRenderer = this.pdf,
  ): Promise<{ ready: number; failed: number }> {
    const queued = (
      await this.db.execute(sql`
        SELECT * FROM report_exports WHERE status = 'queued' ORDER BY created_at, id LIMIT ${BATCH}
      `)
    ).rows as ExportRow[];
    let ready = 0;
    let failed = 0;
    for (const row of queued) {
      try {
        const access = await this.accessPort.resolve(row.account_id);
        const reveal = row.sensitive && access.permissions.has('reporting.export_sensitive');
        const computed = await this.compute(access, row.report_code, row.params, now, reveal);
        const extension = row.format === 'pdf' ? 'pdf' : 'csv';
        const key = `reports/${row.id}.${extension}`;
        const file =
          row.format === 'pdf'
            ? await renderer.render(
                pdfHtml({
                  title: computed.definition.title,
                  filters: this.filterLines(computed.applied),
                  columns: computed.columns,
                  rows: computed.rows,
                  unit: row.money_unit,
                  who: row.account_name,
                  at: now,
                }),
              )
            : csvOf(computed.columns, computed.rows, row.money_unit);
        await this.storage.put(
          'private',
          key,
          file,
          row.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8',
        );
        await this.db.transaction(async (tx) => {
          await tx.execute(sql`
            UPDATE report_exports SET status = 'ready', row_count = ${computed.rows.length},
              object_key = ${key}, finished_at = ${now.toISOString()}
            WHERE id = ${row.id} AND status = 'queued'
          `);
          await this.exported(
            tx,
            row.id,
            row.report_code,
            row.format,
            computed.rows.length,
            row.sensitive,
          );
        });
        ready += 1;
      } catch (error) {
        // The error's kind only (rule 30): no parameter or value of the report.
        const kind = error instanceof Error ? error.constructor.name : 'unknown error';
        await this.db.execute(sql`
          UPDATE report_exports SET status = 'failed', error = ${kind},
            finished_at = ${now.toISOString()}
          WHERE id = ${row.id} AND status = 'queued'
        `);
        failed += 1;
      }
    }
    return { ready, failed };
  }

  private async exported(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    id: string,
    code: string,
    format: ExportFormat,
    rows: number,
    sensitive: boolean,
  ) {
    await this.outbox.publish(
      {
        type: 'report.exported',
        aggregateType: 'report_export',
        aggregateId: id,
        payload: { exportId: id, reportCode: code, format, rowCount: rows, sensitive },
      },
      tx,
    );
  }

  /** The conditions on top of a PDF, as the reader reads them. */
  private filterLines(applied: Record<string, unknown>): string[] {
    const lines: string[] = [];
    for (const [key, value] of Object.entries(applied)) {
      if (key === 'range' && value && typeof value === 'object') {
        const r = value as { from?: string; to?: string };
        if (r.from && r.to) {
          const day = (at: string) => formatJalaliDate(gregorianToJalali(this.ymd(new Date(at))));
          const last = new Date(new Date(r.to).getTime() - 1);
          lines.push(`بازه: ${day(r.from)} تا ${day(last.toISOString())}`);
        }
      } else if (typeof value === 'string' || typeof value === 'number') {
        lines.push(`${key}: ${String(value)}`);
      }
    }
    return lines;
  }

  /** The Tehran day of an instant, as a Gregorian date. */
  private ymd(at: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(at)
      .split('-')
      .map(Number);
    return { year: parts[0] ?? 0, month: parts[1] ?? 0, day: parts[2] ?? 0 };
  }

  private async exportRow(id: string): Promise<ExportRow | null> {
    return ((await this.db.execute(sql`SELECT * FROM report_exports WHERE id = ${id}`)).rows[0] ??
      null) as ExportRow | null;
  }

  private exportView(r: ExportRow | null): ReportExport {
    if (!r) throw new NotFoundException({ error: 'export_not_found' });
    return {
      id: r.id,
      reportCode: r.report_code,
      format: r.format,
      moneyUnit: r.money_unit,
      sensitive: r.sensitive,
      status: r.status,
      rowCount: r.row_count,
      createdAt: iso(r.created_at),
      finishedAt: isoOrNull(r.finished_at),
    };
  }

  // --- saved filters (doc 17 §4) --------------------------------------------------------------

  async filters(access: EffectiveAccess, reportCode?: string): Promise<SavedFilter[]> {
    need(access, 'reporting.run');
    const units = access.roles.length > 0 ? access.roles : ['-'];
    const rows = (
      await this.db.execute(sql`
        SELECT id, owner_account_id, report_code, name, conditions, shared_unit, created_at
        FROM report_saved_filters
        WHERE deleted_at IS NULL
          AND (owner_account_id = ${access.accountId}
            OR shared_unit IN (${sql.join(
              units.map((u) => sql`${u}`),
              sql`, `,
            )}))
          AND ${reportCode ? sql`report_code = ${reportCode}` : sql`true`}
        ORDER BY name, id
      `)
    ).rows;
    return rows
      .filter((r) => {
        const d = this.registry.get(r['report_code'] as string);
        return d !== undefined && this.allowed(access, d);
      })
      .map((r) => ({
        id: r['id'] as string,
        reportCode: r['report_code'] as string,
        name: r['name'] as string,
        conditions: r['conditions'] as Record<string, unknown>,
        sharedUnit: (r['shared_unit'] as string | null) ?? null,
        mine: r['owner_account_id'] === access.accountId,
        createdAt: iso(r['created_at']),
      }));
  }

  /** Conditions only, a relative range kept relative; shared only with one's own unit. */
  async saveFilter(
    actor: Actor,
    access: EffectiveAccess,
    input: {
      reportCode: string;
      name: string;
      conditions: Record<string, unknown>;
      sharedUnit?: string | undefined;
    },
  ): Promise<SavedFilter> {
    need(access, 'reporting.run');
    const definition = this.registry.get(input.reportCode);
    if (!definition || !this.allowed(access, definition)) throw notFound();
    if (!definition.params.safeParse(input.conditions).success) {
      throw new BadRequestException({ error: 'invalid_params' });
    }
    if (input.sharedUnit !== undefined) {
      need(access, 'reporting.share_filters');
      if (!access.roles.includes(input.sharedUnit)) {
        throw new ForbiddenException({ error: 'not_your_unit' });
      }
    }
    const id = await this.db
      .transaction(async (tx) => {
        const made = (
          await tx.execute(sql`
            INSERT INTO report_saved_filters (owner_account_id, report_code, name, conditions,
              shared_unit)
            VALUES (${access.accountId}, ${input.reportCode}, ${input.name},
              ${JSON.stringify(input.conditions)}::jsonb, ${input.sharedUnit ?? null})
            RETURNING id
          `)
        ).rows[0]?.['id'] as string;
        await this.audit.record(
          {
            actor,
            action: 'report.filter_saved',
            entityType: 'report_saved_filter',
            entityId: made,
            after: { reportCode: input.reportCode, sharedUnit: input.sharedUnit ?? null },
          },
          tx,
        );
        return made;
      })
      .catch((error: unknown) => {
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') {
          throw new ConflictException({ error: 'filter_name_taken' });
        }
        throw error;
      });
    const saved = (await this.filters(access, input.reportCode)).find((f) => f.id === id);
    if (!saved) throw new Error('saved filter not found after saving');
    return saved;
  }

  /** The owner deletes their filter, softly (rule 7). */
  async deleteFilter(actor: Actor, access: EffectiveAccess, id: string): Promise<void> {
    need(access, 'reporting.run');
    if (!UUID.test(id)) throw new NotFoundException({ error: 'filter_not_found' });
    await this.db.transaction(async (tx) => {
      const done = await tx.execute(sql`
        UPDATE report_saved_filters SET deleted_at = now(), deleted_by = ${access.accountId}
        WHERE id = ${id} AND owner_account_id = ${access.accountId} AND deleted_at IS NULL
        RETURNING id
      `);
      if (done.rows.length === 0) throw new NotFoundException({ error: 'filter_not_found' });
      await this.audit.record(
        { actor, action: 'report.filter_deleted', entityType: 'report_saved_filter', entityId: id },
        tx,
      );
    });
  }

  /** A saved filter run with the caller's scope as it is now (doc 17 §4). */
  async runFilter(access: EffectiveAccess, id: string, now = new Date()): Promise<ReportResult> {
    const filter = (await this.filters(access)).find((f) => f.id === id);
    if (!filter) throw new NotFoundException({ error: 'filter_not_found' });
    return this.run(access, filter.reportCode, filter.conditions, now);
  }
}
