import { Inject, Injectable } from '@nestjs/common';
import type { CenterStatus } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../../common/audit/audit.port';
import type {
  WorkplaceCandidate,
  WorkplaceDirectory,
  WorkplaceRecord,
} from '../../common/catalog/workplace-directory.port';
import { DATABASE, type Database } from '../../db/database.module';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `%`, `_` and `\` are literal in a search term. */
const likeEscaped = (term: string) => term.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The WORKPLACE_DIRECTORY port (task 2-5): booking learns a workplace's doctor, place in
 * the tree and center status, and who its secretaries are, without reading these tables.
 * Runs in the caller's transaction when given one.
 */
@Injectable()
export class WorkplaceDirectoryService implements WorkplaceDirectory {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async workplace(workplaceId: string, tx?: SqlExecutor): Promise<WorkplaceRecord | null> {
    if (!UUID.test(workplaceId)) return null;
    const result = await (tx ?? this.db).execute(sql`
      SELECT w.id, w.doctor_id, d.account_id, w.node_id, w.node_path::text AS node_path,
             w.city_code, w.center_id, c.status AS center_status, d.name AS doctor_name,
             c.name AS center_name
      FROM doctor_workplaces w
      JOIN doctors d ON d.id = w.doctor_id AND d.deleted_at IS NULL
      LEFT JOIN centers c ON c.id = w.center_id
      WHERE w.id = ${workplaceId} AND w.deleted_at IS NULL
    `);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row['id'] as string,
      doctorId: row['doctor_id'] as string,
      doctorAccountId: (row['account_id'] as string | null) ?? null,
      nodeId: row['node_id'] as string,
      nodePath: row['node_path'] as string,
      cityCode: row['city_code'] as string,
      centerId: (row['center_id'] as string | null) ?? null,
      centerStatus: (row['center_status'] as CenterStatus | null) ?? null,
      doctorName: row['doctor_name'] as string,
      placeName: (row['center_name'] as string | null) ?? null,
    };
  }

  async workplaceByNode(nodeId: string, tx?: SqlExecutor): Promise<WorkplaceRecord | null> {
    if (!UUID.test(nodeId)) return null;
    const found = await (tx ?? this.db).execute(sql`
      SELECT id FROM doctor_workplaces WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `);
    const id = found.rows[0]?.['id'] as string | undefined;
    return id ? this.workplace(id, tx) : null;
  }

  async workplacesUnder(paths: readonly string[], tx?: SqlExecutor): Promise<WorkplaceRecord[]> {
    if (paths.length === 0) return [];
    const result = await (tx ?? this.db).execute(sql`
      SELECT w.id, w.doctor_id, d.account_id, w.node_id, w.node_path::text AS node_path,
             w.city_code, w.center_id, c.status AS center_status, d.name AS doctor_name,
             c.name AS center_name
      FROM doctor_workplaces w
      JOIN doctors d ON d.id = w.doctor_id
      LEFT JOIN centers c ON c.id = w.center_id
      WHERE ${sql.join(
        paths.map((p) => sql`(w.node_path = ${p} OR w.node_path LIKE ${`${p}.%`})`),
        sql` OR `,
      )}
      ORDER BY w.id
    `);
    return result.rows.map((row) => ({
      id: row['id'] as string,
      doctorId: row['doctor_id'] as string,
      doctorAccountId: (row['account_id'] as string | null) ?? null,
      nodeId: row['node_id'] as string,
      nodePath: row['node_path'] as string,
      cityCode: row['city_code'] as string,
      centerId: (row['center_id'] as string | null) ?? null,
      centerStatus: (row['center_status'] as CenterStatus | null) ?? null,
      doctorName: row['doctor_name'] as string,
      placeName: (row['center_name'] as string | null) ?? null,
    }));
  }

  async doctorFieldCodes(workplaceId: string, tx?: SqlExecutor): Promise<string[]> {
    if (!UUID.test(workplaceId)) return [];
    const result = await (tx ?? this.db).execute(sql`
      SELECT df.field_code FROM doctor_treatment_fields df
      JOIN doctor_workplaces w ON w.doctor_id = df.doctor_id
      WHERE w.id = ${workplaceId} AND df.deleted_at IS NULL
      ORDER BY df.field_code
    `);
    return result.rows.map((r) => r['field_code'] as string);
  }

  async changeCandidates(
    input: {
      readonly fieldCode: string;
      readonly cityCode: string;
      readonly excludeNodeId: string;
      readonly term: string | null;
      readonly matchDoctorName: boolean;
      readonly limit: number;
    },
    tx?: SqlExecutor,
  ): Promise<WorkplaceCandidate[]> {
    const like = input.term ? `%${likeEscaped(input.term)}%` : null;
    const doctorLike = input.matchDoctorName ? like : null;
    const result = await (tx ?? this.db).execute(sql`
      SELECT w.id, d.name AS doctor_name, c.name AS center_name
      FROM doctor_workplaces w
      JOIN doctors d ON d.id = w.doctor_id AND d.deleted_at IS NULL
      JOIN doctor_treatment_fields df
        ON df.doctor_id = d.id AND df.field_code = ${input.fieldCode} AND df.deleted_at IS NULL
      LEFT JOIN centers c ON c.id = w.center_id
      LEFT JOIN branches b ON b.id = w.branch_id
      WHERE w.deleted_at IS NULL
        AND w.city_code = ${input.cityCode}
        AND w.node_id <> ${input.excludeNodeId}
        AND (w.center_id IS NULL OR (c.status = 'active' AND c.deleted_at IS NULL))
        AND (w.branch_id IS NULL OR b.deleted_at IS NULL)
        AND (${like}::text IS NULL OR d.name ILIKE ${doctorLike} OR c.name ILIKE ${like})
      ORDER BY d.name, c.name NULLS FIRST, w.id
      LIMIT ${input.limit}
    `);
    return result.rows.map((r) => ({
      workplaceId: r['id'] as string,
      doctorName: r['doctor_name'] as string,
      centerName: (r['center_name'] as string | null) ?? null,
    }));
  }

  async isSecretary(workplaceId: string, accountId: string, tx?: SqlExecutor): Promise<boolean> {
    if (!UUID.test(workplaceId) || !UUID.test(accountId)) return false;
    const result = await (tx ?? this.db).execute(sql`
      SELECT 1 FROM doctor_secretaries
      WHERE workplace_id = ${workplaceId} AND account_id = ${accountId} AND deleted_at IS NULL
    `);
    return result.rows.length > 0;
  }

  async serviceNames(codes: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const names = new Map<string, string>();
    if (codes.length === 0) return names;
    const result = await this.db.execute(
      sql`SELECT code, name FROM services WHERE code IN ${[...new Set(codes)]}`,
    );
    for (const r of result.rows) names.set(String(r['code']), String(r['name']));
    return names;
  }

  async offerableServiceCodes(workplaceId: string, tx?: SqlExecutor): Promise<string[]> {
    if (!UUID.test(workplaceId)) return [];
    const result = await (tx ?? this.db).execute(sql`
      SELECT s.code FROM services s
      WHERE s.deleted_at IS NULL
        AND (s.kind = 'visit' OR s.field_id IN (
          SELECT f.id FROM treatment_fields f
          JOIN doctor_treatment_fields df ON df.field_code = f.code AND df.deleted_at IS NULL
          JOIN doctor_workplaces w ON w.doctor_id = df.doctor_id
          WHERE w.id = ${workplaceId} AND f.deleted_at IS NULL))
      ORDER BY s.code
    `);
    return result.rows.map((r) => r['code'] as string);
  }

  async treatmentFieldFor(
    workplaceId: string,
    serviceCode: string,
    tx?: SqlExecutor,
  ): Promise<string | null> {
    if (!UUID.test(workplaceId)) return null;
    const offerable = await this.offerableServiceCodes(workplaceId, tx);
    if (!offerable.includes(serviceCode)) return null;
    const result = await (tx ?? this.db).execute(sql`
      SELECT COALESCE(
        (SELECT f.code FROM services s JOIN treatment_fields f ON f.id = s.field_id
         WHERE s.code = ${serviceCode} AND s.deleted_at IS NULL),
        (SELECT df.field_code FROM doctor_treatment_fields df
         JOIN doctor_workplaces w ON w.doctor_id = df.doctor_id
         WHERE w.id = ${workplaceId} AND df.deleted_at IS NULL
         ORDER BY df.field_code LIMIT 1)
      ) AS code
    `);
    return (result.rows[0]?.['code'] as string | null | undefined) ?? null;
  }
}
