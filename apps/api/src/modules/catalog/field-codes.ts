import { BadRequestException } from '@nestjs/common';
import { and, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../db/database.module';
import { treatmentFields } from './catalog.schema';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * A center or doctor picks treatment fields only from the catalog, and never a retired one
 * (task 2-4). The foreign key also refuses an unknown code; this gives a clear 400 instead,
 * and catches the retired ones the key cannot see.
 */
export async function requireActiveFieldCodes(tx: Tx, codes: readonly string[]): Promise<void> {
  if (codes.length === 0) return;
  const rows = await tx
    .select({ code: treatmentFields.code })
    .from(treatmentFields)
    .where(and(inArray(treatmentFields.code, [...codes]), isNull(treatmentFields.deletedAt)));
  const known = new Set(rows.map((r) => r.code));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw new BadRequestException({ error: 'unknown_treatment_field', codes: unknown });
  }
}
