import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  bankColumnMapSchema,
  mapStatementRows,
  readCsv,
  type BankColumnMap,
  type MappedStatementRow,
} from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { AUDIT_LOG, type Actor, type AuditLog } from '../../common/audit/audit.port';
import { INCOME_ENTITIES } from '../../common/ledger/income-entities';
import { MALWARE_SCANNER, type MalwareScanner } from '../../common/security/malware-scanner.port';
import { OBJECT_STORAGE, type ObjectStorage } from '../../common/storage/object-storage.port';
import { readFirstSheet, XlsxError } from '../../common/xlsx';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY = INCOME_ENTITIES[0];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const LIMITS = { maxInflatedBytes: 20 * 1024 * 1024, maxZipEntries: 200, maxRows: 5_000 };
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const PREVIEW_ROWS = 5;
/** A probable match: the same amount within this many days of the slip's. */
const PROBABLE_DAYS = 2;

const iso = (c: string) =>
  sql.raw(`to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/**
 * Bank statements (task 6-3 [near money]; doc 15 §2; owner 1405/07/15): a file of the
 * collection account read through a mapping its uploader chooses (rials unless said; a few
 * rows and the sum shown before it is confirmed; the last mapping offered next time); each
 * row suggests a slip, exactly (same bank reference and amount) or probably (same amount,
 * within two days), or is an unknown deposit to review. Nothing is posted and no payment
 * changes: approval is task 6-2's path. The same file again is the same import.
 */
@Injectable()
export class BankStatementService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async preview(file: { buffer: Buffer } | undefined, rawMap: string | undefined) {
    const rows = await this.read(file);
    const map = this.mapOf(rawMap);
    const mapped = map ? mapStatementRows(rows, map) : null;
    return {
      headers: rows[0] ?? [],
      sampleRows: rows.slice(1, 1 + PREVIEW_ROWS),
      suggestedMap: await this.lastMap(),
      mapped: mapped
        ? {
            rows: mapped.slice(0, PREVIEW_ROWS).map((r) => ({
              rowNo: r.rowNo,
              paidOn: r.paidOn,
              amountRial: r.amountRial?.toString() ?? null,
              bankRef: r.bankRef,
              invalid: r.invalid,
            })),
            totalRial: total(mapped).toString(),
            validRows: mapped.filter((r) => !r.invalid).length,
            invalidRows: mapped.filter((r) => r.invalid).length,
          }
        : null,
    };
  }

  async import(actor: Actor, file: { buffer: Buffer } | undefined, rawMap: string | undefined) {
    const map = this.mapOf(rawMap);
    if (!map) throw new BadRequestException({ error: 'column_map_required' });
    const rows = await this.read(file);
    const buffer = (file as { buffer: Buffer }).buffer;
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const earlier = await this.byHash(sha256);
    if (earlier) return { ...(await this.summary(earlier)), replayed: true };

    const mapped = mapStatementRows(rows, map);
    const key = `bank-statements/${sha256}`;
    await this.storage.put('private', key, buffer, 'application/octet-stream');
    const id = await this.db
      .transaction(async (tx) => {
        const made = await tx.execute(sql`
          INSERT INTO bank_statement_imports
            (entity_id, file_sha256, file_key, column_map, rows_count, total_rial, uploaded_by)
          VALUES (${ENTITY}, ${sha256}, ${key}, ${JSON.stringify(map)}::jsonb, ${mapped.length},
                  ${total(mapped)}, ${actor.accountId})
          RETURNING id
        `);
        const importId = made.rows[0]?.['id'] as string;
        for (const r of mapped) {
          const match = r.invalid ? null : await this.match(tx, r);
          await tx.execute(sql`
            INSERT INTO bank_statement_rows (import_id, row_no, paid_on, amount_rial, bank_ref,
              bank_ref_norm, description, match_kind, suggested_payment_id)
            VALUES (${importId}, ${r.rowNo}, ${r.paidOn}, ${r.amountRial}, ${r.bankRef},
                    ${r.bankRefNorm}, ${r.description},
                    ${r.invalid ? 'invalid' : (match?.kind ?? 'none')}, ${match?.paymentId ?? null})
          `);
        }
        // The mapping offered for the next file (the owner).
        await tx.execute(sql`
          INSERT INTO bank_statement_column_maps (entity_id, column_map, created_by)
          VALUES (${ENTITY}, ${JSON.stringify(map)}::jsonb, ${actor.accountId})
        `);
        await this.audit.record(
          {
            actor,
            action: 'repayment.bank_statement_imported',
            entityType: 'bank_statement_import',
            entityId: importId,
            after: { rows: mapped.length, totalRial: total(mapped).toString(), sha256 },
          },
          tx,
        );
        return importId;
      })
      .catch(async (error: unknown) => {
        // The same file at the same moment: the other import.
        const e = error as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') {
          const other = await this.byHash(sha256);
          if (other) return other;
        }
        throw error;
      });
    return { ...(await this.summary(id)), replayed: false };
  }

  async rows(importId: string, kind?: 'exact' | 'probable' | 'none' | 'invalid') {
    if (!UUID.test(importId)) throw new NotFoundException({ error: 'import_not_found' });
    const rows = await this.db.execute(sql`
      SELECT r.id, r.row_no, r.paid_on::text AS paid_on, r.amount_rial::text AS amount,
             r.bank_ref, r.description, r.match_kind, r.suggested_payment_id,
             ${iso('r.reviewed_at')} AS reviewed_at, r.review_note,
             -- Task 6-8 (owner ۶): a cleared cheque's payment carries its instrument's key.
             coalesce(starts_with(p.idempotency_key, 'instrument:'), false) AS related_to_cheque
      FROM bank_statement_rows r LEFT JOIN payments p ON p.id = r.suggested_payment_id
      WHERE r.import_id = ${importId}
        AND (${kind ?? null}::text IS NULL OR r.match_kind = ${kind ?? null})
      ORDER BY r.row_no
    `);
    return rows.rows.map((r) => ({
      id: r['id'] as string,
      rowNo: r['row_no'] as number,
      paidOn: (r['paid_on'] as string | null) ?? null,
      amountRial: (r['amount'] as string | null) ?? null,
      bankRef: (r['bank_ref'] as string | null) ?? null,
      description: (r['description'] as string | null) ?? null,
      matchKind: r['match_kind'] as 'exact' | 'probable' | 'none' | 'invalid',
      suggestedPaymentId: (r['suggested_payment_id'] as string | null) ?? null,
      relatedToCheque: r['related_to_cheque'] === true,
      reviewedAt: (r['reviewed_at'] as string | null) ?? null,
      reviewNote: (r['review_note'] as string | null) ?? null,
    }));
  }

  /** A row looked at, with a note: nothing else (an unknown deposit is entered by staff). */
  async review(actor: Actor, rowId: string, note: string) {
    if (!UUID.test(rowId)) throw new NotFoundException({ error: 'row_not_found' });
    const row = await this.db.transaction(async (tx) => {
      const done = await tx.execute(sql`
        UPDATE bank_statement_rows
        SET reviewed_by = ${actor.accountId}, reviewed_at = now(), review_note = ${note}
        WHERE id = ${rowId} AND reviewed_at IS NULL
        RETURNING import_id
      `);
      const importId = done.rows[0]?.['import_id'] as string | undefined;
      if (!importId) {
        const exists = await tx.execute(sql`SELECT 1 FROM bank_statement_rows WHERE id = ${rowId}`);
        if (exists.rows.length === 0) throw new NotFoundException({ error: 'row_not_found' });
        return null;
      }
      await this.audit.record(
        {
          actor,
          action: 'repayment.bank_statement_row_reviewed',
          entityType: 'bank_statement_row',
          entityId: rowId,
          reason: note,
        },
        tx,
      );
      return importId;
    });
    const importId =
      row ??
      ((await this.db.execute(sql`SELECT import_id FROM bank_statement_rows WHERE id = ${rowId}`))
        .rows[0]?.['import_id'] as string);
    return (await this.rows(importId)).find((r) => r.id === rowId);
  }

  // --- helpers ----------------------------------------------------------------------------

  /** Scanned before anything reads it (rule 28); an XLSX or a CSV, by its bytes. */
  private async read(file: { buffer: Buffer } | undefined): Promise<string[][]> {
    if (!file) throw new BadRequestException({ error: 'file_required' });
    if (file.buffer.length > MAX_FILE_BYTES)
      throw new BadRequestException({ error: 'file_too_large' });
    const scan = await this.scanner.scan(file.buffer);
    if (!scan.clean) throw new BadRequestException({ error: 'file_infected' });
    if (ZIP.every((b, i) => file.buffer[i] === b)) {
      try {
        return readFirstSheet(new Uint8Array(file.buffer), LIMITS);
      } catch (error) {
        if (error instanceof XlsxError) throw new BadRequestException({ error: error.code });
        throw error;
      }
    }
    const text = file.buffer.toString('utf8');
    // A CSV is text: no NUL, nothing that did not decode.
    if (text.includes('\u0000') || text.includes(String.fromCharCode(0xfffd))) {
      throw new BadRequestException({ error: 'unsupported_type' });
    }
    try {
      return readCsv(text, LIMITS.maxRows);
    } catch {
      throw new BadRequestException({ error: 'too_many_rows' });
    }
  }

  private mapOf(raw: string | undefined): BankColumnMap | null {
    if (raw === undefined || raw === '') return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BadRequestException({ error: 'invalid_column_map' });
    }
    const parsed = bankColumnMapSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_column_map' });
    return parsed.data;
  }

  private async lastMap(): Promise<BankColumnMap | null> {
    const row = (
      await this.db.execute(sql`
        SELECT column_map FROM bank_statement_column_maps WHERE entity_id = ${ENTITY}
        ORDER BY created_at DESC, id DESC LIMIT 1
      `)
    ).rows[0];
    if (!row) return null;
    const parsed = bankColumnMapSchema.safeParse(row['column_map']);
    return parsed.success ? parsed.data : null;
  }

  /** Exact: same bank reference and amount; probable: same amount within two days, pending. */
  private async match(
    ex: Parameters<Parameters<Database['transaction']>[0]>[0],
    r: MappedStatementRow,
  ): Promise<{ kind: 'exact' | 'probable'; paymentId: string } | null> {
    if (r.bankRefNorm) {
      const exact = (
        await ex.execute(sql`
          SELECT id FROM payments
          WHERE bank_ref_norm = ${r.bankRefNorm} AND amount_rial = ${r.amountRial}
            AND status <> 'rejected'
          ORDER BY created_at LIMIT 1
        `)
      ).rows[0];
      if (exact) return { kind: 'exact', paymentId: exact['id'] as string };
    }
    const probable = (
      await ex.execute(sql`
        SELECT id FROM payments
        WHERE amount_rial = ${r.amountRial} AND status = 'pending_approval' AND paid_on IS NOT NULL
          AND abs(paid_on - ${r.paidOn}::date) <= ${PROBABLE_DAYS}
        ORDER BY abs(paid_on - ${r.paidOn}::date), created_at LIMIT 1
      `)
    ).rows[0];
    return probable ? { kind: 'probable', paymentId: probable['id'] as string } : null;
  }

  private async byHash(sha256: string): Promise<string | null> {
    const row = (
      await this.db.execute(sql`
        SELECT id FROM bank_statement_imports WHERE entity_id = ${ENTITY} AND file_sha256 = ${sha256}
      `)
    ).rows[0];
    return (row?.['id'] as string | undefined) ?? null;
  }

  private async summary(id: string) {
    const head = (
      await this.db.execute(sql`
        SELECT rows_count, total_rial::text AS total FROM bank_statement_imports WHERE id = ${id}
      `)
    ).rows[0];
    const counts = await this.db.execute(sql`
      SELECT match_kind, count(*)::int AS n FROM bank_statement_rows WHERE import_id = ${id}
      GROUP BY match_kind
    `);
    const by = (k: string) =>
      (counts.rows.find((r) => r['match_kind'] === k)?.['n'] as number | undefined) ?? 0;
    return {
      id,
      rows: head?.['rows_count'] as number,
      totalRial: head?.['total'] as string,
      matches: {
        exact: by('exact'),
        probable: by('probable'),
        none: by('none'),
        invalid: by('invalid'),
      },
    };
  }
}

const total = (rows: readonly MappedStatementRow[]) =>
  rows.reduce((s, r) => s + (r.invalid ? 0n : (r.amountRial ?? 0n)), 0n);
