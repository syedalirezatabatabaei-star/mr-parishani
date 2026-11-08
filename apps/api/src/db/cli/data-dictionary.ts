/**
 * `pnpm db:data-dictionary` (task 7-6; doc 17 §7): rewrites `docs/data-dictionary.md` from the
 * live schema (DATABASE_URL, read only). Fails, writing nothing, if a table or a column's word
 * has no Persian yet.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDataDictionary } from '../data-dictionary/build';
import { createPool, databaseUrlFromEnv } from '../pool';

export const DATA_DICTIONARY_FILE = join(__dirname, '../../../../../docs/data-dictionary.md');

async function main(): Promise<void> {
  const pool = createPool(databaseUrlFromEnv('DATABASE_URL'), 'data-dictionary');
  try {
    const d = await buildDataDictionary(pool);
    const gaps = [...d.missingTables, ...d.staleTables, ...d.missingTokens];
    if (gaps.length > 0) {
      console.error(`no Persian yet for:\n${gaps.join('\n')}`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(DATA_DICTIONARY_FILE, d.markdown);
    console.log(`written: ${DATA_DICTIONARY_FILE}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    'data dictionary failed:',
    error instanceof Error ? error.message : 'unknown error',
  );
  process.exitCode = 1;
});
