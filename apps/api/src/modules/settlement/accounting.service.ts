import { createHash } from 'node:crypto';
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
  statementPeriod,
  toJalali,
  type HeldReportRow,
  type NegativeReportRow,
  type OdooExport,
  type OdooMapping,
  type PermissionCode,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
} from '../../common/catalog/workplace-directory.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { INCOME_ENTITIES } from '../../common/ledger/income-entities';
import { LEDGER, type LedgerPort } from '../../common/ledger/ledger.port';
import { DATABASE, type Database } from '../../db/database.module';

const REPORTS: PermissionCode = 'settlement.read_reports';
const ODOO: PermissionCode = 'settlement.manage_odoo_mapping';
/** Version one has one lender (ADR-007): its books are what Odoo gets. */
const ENTITY = INCOME_ENTITIES[0];

const iso = (c: string) =>
  sql.raw(`to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
const csvField = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Excel and Odoo read UTF-8 with it. */
const BOM = String.fromCharCode(0xfeff);
const pad = (n: number) => String(n).padStart(2, '0');

/** The stable id Odoo keeps for a document (doc 06 §7): the same on every export. */
export const odooExternalId = (journalEntryId: string) => `sepehr-je-${journalEntryId}`;

/**
 * The accounting panel's reports and the Odoo 19 export (task 5-7; doc 06 §7; doc 14 ث;
 * owner 5.5). Read only, but for the mapping (append-only) and the export's own record.
 *
 * The export: every document of the lender whose business moment is in the Jalali month
 * (Tehran), each line on the Odoo account its internal code is mapped to; an unmapped code
 * refuses the whole file. External ids are the documents' own, so exporting a month again
 * gives the same ids, never new ones. No VAT (doc 06 §7). A partner is its owner's type and
 * id, never a name or national code (rule 30).
 */
@Injectable()
export class AccountingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(LEDGER) private readonly ledger: LedgerPort,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
  ) {}

  // --- reports ----------------------------------------------------------------------------

  /** Every item held by a dispute, with where its dispute is. */
  async held(access: EffectiveAccess): Promise<HeldReportRow[]> {
    this.require(access, REPORTS);
    const rows = await this.db.execute(sql`
      SELECT 'credit_service' AS kind, p.id, p.doctor_id, p.workplace_id,
             p.amount_rial::text AS amount, ${iso('p.due_at')} AS due_at,
             d.id AS dispute_id, d.status AS dispute_status, ${iso('d.opened_at')} AS opened_at
      FROM doctor_payables p LEFT JOIN financial_disputes d ON d.id = p.dispute_id
      WHERE p.status = 'on_hold'
      UNION ALL
      SELECT 'cash_fee', f.id, f.doctor_id, c.workplace_id, f.amount_rial::text,
             ${iso('f.due_at')}, d.id, d.status, ${iso('d.opened_at')}
      FROM service_fees f
      JOIN cash_services c ON c.id = f.cash_service_id
      LEFT JOIN financial_disputes d ON d.id = f.dispute_id
      WHERE f.kind = 'cash' AND f.status = 'on_hold'
      ORDER BY 9 NULLS LAST, 2
      LIMIT 1000
    `);
    const names = this.names();
    const out: HeldReportRow[] = [];
    for (const r of rows.rows) {
      out.push({
        kind: r['kind'] as HeldReportRow['kind'],
        itemId: r['id'] as string,
        doctorId: r['doctor_id'] as string,
        providerName: await names(r['workplace_id'] as string),
        amountRial: r['amount'] as string,
        dueAt: r['due_at'] as string,
        disputeId: (r['dispute_id'] as string | null) ?? null,
        disputeStatus: (r['dispute_status'] as HeldReportRow['disputeStatus']) ?? null,
        openedAt: (r['opened_at'] as string | null) ?? null,
      });
    }
    return out;
  }

  /**
   * Doctors whose latest live statement carried a balance (doc 14 پ), with how many
   * statements in a row did; flagged from the configured number of periods.
   */
  async negative(access: EffectiveAccess): Promise<NegativeReportRow[]> {
    this.require(access, REPORTS);
    const threshold = await this.config.resolve(
      'settlement.negative_balance_alert_periods',
      {},
      new Date(),
    );
    const rows = await this.db.execute(sql`
      SELECT s.doctor_id, s.period_year, s.period_month, s.carried_out_rial::text AS carried,
             (SELECT coalesce(p.workplace_id, c.workplace_id)
              FROM settlement_statement_lines l
              LEFT JOIN doctor_payables p ON l.ref_type = 'doctor_payable' AND p.id = l.ref_id
              LEFT JOIN service_fees f ON l.ref_type = 'service_fee' AND f.id = l.ref_id
              LEFT JOIN cash_services c ON c.id = f.cash_service_id
              WHERE l.statement_id = s.id AND coalesce(p.workplace_id, c.workplace_id) IS NOT NULL
              LIMIT 1) AS workplace_id
      FROM settlement_statements s
      WHERE s.status <> 'cancelled'
      ORDER BY s.doctor_id, s.period_year DESC, s.period_month DESC
    `);
    const byDoctor = new Map<string, Record<string, unknown>[]>();
    for (const r of rows.rows) {
      const id = r['doctor_id'] as string;
      byDoctor.set(id, [...(byDoctor.get(id) ?? []), r]);
    }
    const names = this.names();
    const out: NegativeReportRow[] = [];
    for (const [doctorId, list] of byDoctor) {
      const latest = list[0];
      if (!latest || BigInt(latest['carried'] as string) === 0n) continue;
      let periods = 0;
      for (const r of list) {
        if (BigInt(r['carried'] as string) === 0n) break;
        periods += 1;
      }
      const workplaceId =
        (list.find((r) => r['workplace_id'])?.['workplace_id'] as string | undefined) ?? null;
      out.push({
        doctorId,
        providerName: workplaceId ? await names(workplaceId) : '',
        periodYear: latest['period_year'] as number,
        periodMonth: latest['period_month'] as number,
        carriedOutRial: latest['carried'] as string,
        periods,
        alert: periods >= threshold.value,
      });
    }
    return out.sort((a, b) => b.periods - a.periods || a.doctorId.localeCompare(b.doctorId));
  }

  // --- Odoo -------------------------------------------------------------------------------

  /** The mapping in force: each internal code's newest row. */
  async mappings(access: EffectiveAccess): Promise<OdooMapping[]> {
    this.require(access, ODOO);
    return [...(await this.currentMappings()).values()];
  }

  async setMapping(
    actor: Actor,
    access: EffectiveAccess,
    input: { internalCode: string; odooAccountCode: string; reason: string },
  ): Promise<OdooMapping[]> {
    this.require(access, ODOO);
    const before = (await this.currentMappings()).get(input.internalCode);
    await this.db.transaction(async (tx) => {
      const made = await tx.execute(sql`
        INSERT INTO odoo_account_mappings (entity_id, internal_code, odoo_account_code, reason, set_by)
        VALUES (${ENTITY}, ${input.internalCode}, ${input.odooAccountCode}, ${input.reason},
                ${actor.accountId})
        RETURNING id
      `);
      await this.audit.record(
        {
          actor,
          action: 'settlement.odoo_mapping_set',
          entityType: 'odoo_account_mapping',
          entityId: made.rows[0]?.['id'] as string,
          before: before ? { odooAccountCode: before.odooAccountCode } : null,
          after: { internalCode: input.internalCode, odooAccountCode: input.odooAccountCode },
          reason: input.reason,
        },
        tx,
      );
    });
    return this.mappings(access);
  }

  async exports(access: EffectiveAccess): Promise<OdooExport[]> {
    this.require(access, ODOO);
    const rows = await this.db.execute(sql`
      SELECT id, period_year, period_month, documents, debit_total_rial::text AS debit,
             credit_total_rial::text AS credit, sha256, ${iso('generated_at')} AS generated_at
      FROM odoo_exports WHERE entity_id = ${ENTITY}
      ORDER BY generated_at DESC LIMIT 200
    `);
    return rows.rows.map((r) => ({
      id: r['id'] as string,
      periodYear: r['period_year'] as number,
      periodMonth: r['period_month'] as number,
      documents: r['documents'] as number,
      debitTotalRial: r['debit'] as string,
      creditTotalRial: r['credit'] as string,
      sha256: r['sha256'] as string,
      generatedAt: r['generated_at'] as string,
    }));
  }

  /** One Jalali month's documents as an Odoo import file; recorded with its totals. */
  async export(
    actor: Actor,
    access: EffectiveAccess,
    year: number,
    month: number,
    now = new Date(),
  ): Promise<OdooExport> {
    this.require(access, ODOO);
    const { start, end } = statementPeriod(year, month);
    if (end > now) throw new BadRequestException({ error: 'period_not_over' });
    const journals = await this.ledger.journalsBetween(ENTITY, start, end);
    const mapping = await this.currentMappings();
    const missing = [
      ...new Set(
        journals.flatMap((j) => j.lines.map((l) => l.accountCode)).filter((c) => !mapping.has(c)),
      ),
    ].sort();
    if (missing.length > 0)
      throw new ConflictException({ error: 'odoo_mapping_missing', codes: missing });

    const header = [
      'external_id',
      'line_id',
      'date',
      'date_jalali',
      'journal_ref',
      'account',
      'internal_account',
      'partner_ref',
      'debit',
      'credit',
    ];
    const lines: string[][] = [header];
    let debit = 0n;
    let credit = 0n;
    for (const j of journals) {
      const day = toJalali(j.occurredAt);
      const jalali = `${String(day.year)}/${pad(day.month)}/${pad(day.day)}`;
      const ref = j.reversesJournalEntryId
        ? `${j.eventType} (reverses ${odooExternalId(j.reversesJournalEntryId)})`
        : j.eventType;
      j.lines.forEach((l, n) => {
        if (l.direction === 'debit') debit += l.amountRial;
        else credit += l.amountRial;
        lines.push([
          odooExternalId(j.id),
          `${odooExternalId(j.id)}-${String(n + 1)}`,
          gregorianDayOf(day),
          jalali,
          ref,
          mapping.get(l.accountCode)?.odooAccountCode ?? '',
          l.accountCode,
          l.ownerId ? `${l.ownerType}:${l.ownerId}` : l.ownerType,
          l.direction === 'debit' ? l.amountRial.toString() : '0',
          l.direction === 'credit' ? l.amountRial.toString() : '0',
        ]);
      });
    }
    if (debit !== credit) throw new Error('the documents of the month do not balance');
    const csv = `${BOM}${lines.map((l) => l.map(csvField).join(',')).join('\r\n')}\r\n`;
    const sha256 = createHash('sha256').update(csv).digest('hex');
    const id = await this.db.transaction(async (tx) => {
      const made = await tx.execute(sql`
        INSERT INTO odoo_exports (entity_id, period_year, period_month, documents,
          debit_total_rial, credit_total_rial, sha256, generated_by)
        VALUES (${ENTITY}, ${year}, ${month}, ${journals.length}, ${debit}, ${credit}, ${sha256},
                ${actor.accountId})
        RETURNING id
      `);
      const exportId = made.rows[0]?.['id'] as string;
      await this.audit.record(
        {
          actor,
          action: 'settlement.odoo_exported',
          entityType: 'odoo_export',
          entityId: exportId,
          after: {
            period: `${String(year)}-${pad(month)}`,
            documents: journals.length,
            debitRial: debit.toString(),
            sha256,
          },
        },
        tx,
      );
      return exportId;
    });
    const made = (await this.exports(access)).find((e) => e.id === id);
    if (!made) throw new NotFoundException({ error: 'export_not_found' });
    return { ...made, csv };
  }

  // --- helpers ----------------------------------------------------------------------------

  private async currentMappings(): Promise<Map<string, OdooMapping>> {
    const rows = await this.db.execute(sql`
      SELECT DISTINCT ON (internal_code) internal_code, odoo_account_code, reason,
             ${iso('set_at')} AS set_at
      FROM odoo_account_mappings WHERE entity_id = ${ENTITY}
      ORDER BY internal_code, set_at DESC, id DESC
    `);
    return new Map(
      rows.rows.map((r) => [
        r['internal_code'] as string,
        {
          internalCode: r['internal_code'] as string,
          odooAccountCode: r['odoo_account_code'] as string,
          reason: r['reason'] as string,
          setAt: r['set_at'] as string,
        },
      ]),
    );
  }

  /** A doctor's name by their workplace, once per workplace. */
  private names() {
    const cache = new Map<string, string>();
    return async (workplaceId: string) => {
      const known = cache.get(workplaceId);
      if (known !== undefined) return known;
      const name = (await this.workplaces.workplace(workplaceId))?.doctorName ?? '';
      cache.set(workplaceId, name);
      return name;
    };
  }

  /** Accounting's reports and books span every city: a global scope only (rule 11). */
  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
    if (!access.scopes.some((s) => s.kind === 'global')) {
      throw new ForbiddenException({ error: 'global_scope_required' });
    }
  }
}
