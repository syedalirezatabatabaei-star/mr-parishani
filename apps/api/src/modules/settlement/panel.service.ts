import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CenterSummaryRow,
  HeldItem,
  PanelStatement,
  PermissionCode,
  UpcomingItem,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { EffectiveAccess } from '../../common/auth/access.port';
import {
  WORKPLACE_DIRECTORY,
  type WorkplaceDirectory,
  type WorkplaceRecord,
} from '../../common/catalog/workplace-directory.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWN: PermissionCode = 'settlement.read_own';
const CENTER: PermissionCode = 'settlement.read_center_summary';
const LINK_SECONDS = 60;
const notFound = () => new NotFoundException({ error: 'statement_not_found' });

/** Where a statement's PDF is kept (private space): its id and the start of its hash. */
export const statementPdfKey = (statementId: string, sha256: string) =>
  `statements/${statementId}/${sha256.slice(0, 16)}.pdf`;

const iso = (c: string) =>
  sql.raw(`to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
const inList = (ids: readonly string[]) =>
  sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  );

/**
 * The doctor's settlement panel (task 5-6; doc 06 §6), read only. A doctor sees what their
 * doctor scope covers (rule 13, as the service module does): a statement only when every
 * doctor node in it is theirs, so one who works in two centers is never shown to either
 * center's people; a center or branch manager sees the sums over the doctors below them,
 * never a doctor's items. Anything else is 404, as if it did not exist.
 */
@Injectable()
export class SettlementPanelService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WORKPLACE_DIRECTORY) private readonly workplaces: WorkplaceDirectory,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async statements(access: EffectiveAccess): Promise<PanelStatement[]> {
    this.require(access, OWN);
    const covered = await this.covered(access);
    const doctors = [...new Set(covered.map((w) => w.doctorId))];
    if (doctors.length === 0) return [];
    const rows = await this.db.execute(sql`
      SELECT id FROM settlement_statements
      WHERE doctor_id IN (${inList(doctors)}) AND status <> 'cancelled'
      ORDER BY period_year DESC, period_month DESC
      LIMIT 120
    `);
    const nodes = new Set(covered.map((w) => w.nodeId));
    const out: PanelStatement[] = [];
    for (const r of rows.rows) {
      const id = r['id'] as string;
      if (await this.whollyCovered(id, nodes)) out.push(await this.view(id));
    }
    return out;
  }

  async statement(access: EffectiveAccess, id: string): Promise<PanelStatement> {
    this.require(access, OWN);
    await this.reach(access, id);
    return this.view(id);
  }

  /** A short-lived signed link to the paid statement's PDF (rule 28). */
  async pdf(
    access: EffectiveAccess,
    id: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    this.require(access, OWN);
    await this.reach(access, id);
    const row = (
      await this.db.execute(sql`SELECT pdf_hash FROM settlement_statements WHERE id = ${id}`)
    ).rows[0];
    const hash = row?.['pdf_hash'] as string | null | undefined;
    if (!hash) throw new ConflictException({ error: 'pdf_not_ready' });
    return {
      url: await this.storage.signedUrl(statementPdfKey(id, hash), LINK_SECONDS),
      expiresInSeconds: LINK_SECONDS,
    };
  }

  /** What is owed and not yet in a statement: the month it falls due and the amount. */
  async upcoming(access: EffectiveAccess): Promise<UpcomingItem[]> {
    this.require(access, OWN);
    const nodes = (await this.covered(access)).map((w) => w.nodeId);
    if (nodes.length === 0) return [];
    const credit = await this.db.execute(sql`
      SELECT p.id, p.amount_rial::text AS amount, coalesce(f.amount_rial, 0)::text AS fee,
             p.status, ${iso('p.due_at')} AS due_at, ${iso('p.finalized_at')} AS occurred_at
      FROM doctor_payables p
      LEFT JOIN service_fees f ON f.doctor_payable_id = p.id
      WHERE p.doctor_node_id IN (${inList(nodes)}) AND p.status IN ('accrued', 'due')
        AND p.statement_id IS NULL
      ORDER BY p.due_at, p.id
    `);
    const cash = await this.db.execute(sql`
      SELECT f.id, f.amount_rial::text AS amount, f.status, ${iso('f.due_at')} AS due_at,
             ${iso("(c.service_date::timestamp AT TIME ZONE 'Asia/Tehran')")} AS occurred_at
      FROM service_fees f JOIN cash_services c ON c.id = f.cash_service_id
      WHERE f.kind = 'cash' AND f.doctor_node_id IN (${inList(nodes)})
        AND f.status IN ('accrued', 'due') AND f.statement_id IS NULL
      ORDER BY f.due_at, f.id
    `);
    return [
      ...credit.rows.map((r) => ({
        kind: 'credit_service' as const,
        itemId: r['id'] as string,
        subjectType: 'doctor_payable' as const,
        amountRial: r['amount'] as string,
        feeRial: r['fee'] as string,
        status: r['status'] as 'accrued' | 'due',
        dueAt: r['due_at'] as string,
        occurredAt: r['occurred_at'] as string,
      })),
      ...cash.rows.map((r) => ({
        kind: 'cash_fee' as const,
        itemId: r['id'] as string,
        subjectType: 'service_fee' as const,
        amountRial: r['amount'] as string,
        feeRial: r['amount'] as string,
        status: r['status'] as 'accrued' | 'due',
        dueAt: r['due_at'] as string,
        occurredAt: r['occurred_at'] as string,
      })),
    ].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  /** Items held by a dispute, with where the dispute is. */
  async held(access: EffectiveAccess): Promise<HeldItem[]> {
    this.require(access, OWN);
    const nodes = (await this.covered(access)).map((w) => w.nodeId);
    if (nodes.length === 0) return [];
    const rows = await this.db.execute(sql`
      SELECT 'credit_service' AS kind, p.id, p.amount_rial::text AS amount,
             ${iso('p.due_at')} AS due_at, d.id AS dispute_id, d.status AS dispute_status,
             ${iso('d.opened_at')} AS opened_at
      FROM doctor_payables p LEFT JOIN financial_disputes d ON d.id = p.dispute_id
      WHERE p.doctor_node_id IN (${inList(nodes)}) AND p.status = 'on_hold'
      UNION ALL
      SELECT 'cash_fee', f.id, f.amount_rial::text, ${iso('f.due_at')}, d.id, d.status,
             ${iso('d.opened_at')}
      FROM service_fees f LEFT JOIN financial_disputes d ON d.id = f.dispute_id
      WHERE f.kind = 'cash' AND f.doctor_node_id IN (${inList(nodes)}) AND f.status = 'on_hold'
      ORDER BY 4, 2
    `);
    return rows.rows.map((r) => ({
      kind: r['kind'] as 'credit_service' | 'cash_fee',
      itemId: r['id'] as string,
      amountRial: r['amount'] as string,
      dueAt: r['due_at'] as string,
      disputeId: (r['dispute_id'] as string | null) ?? null,
      disputeStatus: (r['dispute_status'] as HeldItem['disputeStatus']) ?? null,
      openedAt: (r['opened_at'] as string | null) ?? null,
    }));
  }

  /** A center's sums per month and doctor node below it: never a doctor's items. */
  async centerSummary(access: EffectiveAccess): Promise<CenterSummaryRow[]> {
    this.require(access, CENTER);
    const covered = await this.covered(access, ['center', 'branch']);
    if (covered.length === 0) return [];
    const byNode = new Map(covered.map((w) => [w.nodeId, w]));
    const nodes = [...byNode.keys()];
    const rows = await this.db.execute(sql`
      WITH parts AS (
        SELECT statement_id, doctor_node_id, amount_rial AS gross, 0::bigint AS fees,
               0::bigint AS paid
        FROM doctor_payables WHERE doctor_node_id IN (${inList(nodes)}) AND statement_id IS NOT NULL
        UNION ALL
        SELECT statement_id, doctor_node_id, 0, amount_rial, 0
        FROM service_fees WHERE doctor_node_id IN (${inList(nodes)}) AND statement_id IS NOT NULL
        UNION ALL
        SELECT o.statement_id, n.doctor_node_id, 0, 0, n.amount_rial
        FROM payout_order_nodes n JOIN payout_orders o ON o.id = n.payout_id
        WHERE o.status = 'confirmed' AND n.doctor_node_id IN (${inList(nodes)})
      )
      SELECT s.period_year, s.period_month, s.status, p.doctor_node_id,
             sum(p.gross)::text AS gross, sum(p.fees)::text AS fees, sum(p.paid)::text AS paid
      FROM parts p JOIN settlement_statements s ON s.id = p.statement_id
      WHERE s.status <> 'cancelled'
      GROUP BY s.id, s.period_year, s.period_month, s.status, p.doctor_node_id
      ORDER BY s.period_year DESC, s.period_month DESC, p.doctor_node_id
    `);
    return rows.rows.map((r) => {
      const node = r['doctor_node_id'] as string;
      return {
        periodYear: r['period_year'] as number,
        periodMonth: r['period_month'] as number,
        doctorNodeId: node,
        providerName: byNode.get(node)?.doctorName ?? '',
        statementStatus: r['status'] as CenterSummaryRow['statementStatus'],
        grossRial: r['gross'] as string,
        feesRial: r['fees'] as string,
        paidRial: r['paid'] as string,
      };
    });
  }

  // --- helpers -------------------------------------------------------------------------

  /** The workplaces the caller's node scopes cover (a global or city scope covers none here). */
  private async covered(
    access: EffectiveAccess,
    kinds: readonly ('center' | 'branch' | 'doctor')[] = ['center', 'branch', 'doctor'],
  ): Promise<WorkplaceRecord[]> {
    const paths = access.scopes.flatMap((s) =>
      (s.kind === 'center' || s.kind === 'branch' || s.kind === 'doctor') && kinds.includes(s.kind)
        ? [s.path]
        : [],
    );
    return this.workplaces.workplacesUnder(paths);
  }

  /** Every doctor node in the statement is the caller's. */
  private async whollyCovered(id: string, nodes: ReadonlySet<string>): Promise<boolean> {
    const rows = await this.db.execute(sql`
      SELECT p.doctor_node_id AS node FROM settlement_statement_lines l
      JOIN doctor_payables p ON l.ref_type = 'doctor_payable' AND p.id = l.ref_id
      WHERE l.statement_id = ${id}
      UNION
      SELECT f.doctor_node_id FROM settlement_statement_lines l
      JOIN service_fees f ON l.ref_type = 'service_fee' AND f.id = l.ref_id
      WHERE l.statement_id = ${id}
      UNION
      SELECT ref_id FROM settlement_statement_lines
      WHERE statement_id = ${id} AND ref_type = 'doctor_node'
    `);
    return rows.rows.length > 0 && rows.rows.every((r) => nodes.has(r['node'] as string));
  }

  private async reach(access: EffectiveAccess, id: string): Promise<void> {
    if (!UUID.test(id)) throw notFound();
    const found = (
      await this.db.execute(sql`
        SELECT 1 FROM settlement_statements WHERE id = ${id} AND status <> 'cancelled'
      `)
    ).rows[0];
    if (!found) throw notFound();
    const nodes = new Set((await this.covered(access)).map((w) => w.nodeId));
    if (!(await this.whollyCovered(id, nodes))) throw notFound();
  }

  private async view(id: string): Promise<PanelStatement> {
    const s = (
      await this.db.execute(sql`
        SELECT id, period_year, period_month, status, gross_credit_services_rial::text AS gross,
               credit_fees_rial::text AS credit_fees, cash_fees_rial::text AS cash_fees,
               carried_in_rial::text AS carried_in, other_deductions_rial::text AS other,
               payable_rial::text AS payable, carried_out_rial::text AS carried_out,
               ${iso('generated_at')} AS generated_at, pdf_hash
        FROM settlement_statements WHERE id = ${id}
      `)
    ).rows[0];
    if (!s) throw notFound();
    const items = await this.db.execute(sql`
      SELECT l.line_type, l.ref_id, l.amount_rial::text AS amount,
             ${iso(`coalesce(p.finalized_at, fp.finalized_at,
                   (c.service_date::timestamp AT TIME ZONE 'Asia/Tehran'))`)} AS occurred_at
      FROM settlement_statement_lines l
      LEFT JOIN doctor_payables p ON l.ref_type = 'doctor_payable' AND p.id = l.ref_id
      LEFT JOIN service_fees f ON l.ref_type = 'service_fee' AND f.id = l.ref_id
      LEFT JOIN doctor_payables fp ON fp.id = f.doctor_payable_id
      LEFT JOIN cash_services c ON c.id = f.cash_service_id
      WHERE l.statement_id = ${id}
        AND l.line_type IN ('credit_service', 'credit_fee', 'cash_fee')
      ORDER BY 4, l.line_type, l.ref_id
    `);
    return {
      id: s['id'] as string,
      periodYear: s['period_year'] as number,
      periodMonth: s['period_month'] as number,
      status: s['status'] as PanelStatement['status'],
      grossCreditServicesRial: s['gross'] as string,
      creditFeesRial: s['credit_fees'] as string,
      cashFeesRial: s['cash_fees'] as string,
      carriedInRial: s['carried_in'] as string,
      otherDeductionsRial: s['other'] as string,
      payableRial: s['payable'] as string,
      carriedOutRial: s['carried_out'] as string,
      generatedAt: s['generated_at'] as string,
      pdfReady: s['pdf_hash'] !== null,
      items: items.rows.map((r) => ({
        kind: r['line_type'] as 'credit_service' | 'credit_fee' | 'cash_fee',
        itemId: r['ref_id'] as string,
        amountRial: r['amount'] as string,
        occurredAt: r['occurred_at'] as string,
      })),
    };
  }

  private require(access: EffectiveAccess, permission: PermissionCode) {
    if (!access.permissions.has(permission)) {
      throw new ForbiddenException({ error: 'permission_required', permission });
    }
  }
}
