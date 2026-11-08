import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

/** Lowercase words joined by single underscores: `credit_cases`, `amount_rial`. */
function isSnakeCase(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name) && !name.includes('__') && !name.endsWith('_');
}
const FLOATING_OR_DECIMAL = new Set([
  'PgReal',
  'PgDoublePrecision',
  'PgNumeric',
  'PgNumericNumber',
  'PgNumericBigInt',
]);
const TIMESTAMP = new Set(['PgTimestamp', 'PgTimestampString']);

/**
 * Checks tables against the base rules and returns one message per violation:
 * snake_case names, a UUID `id` primary key, money only as `bigint`
 * `*_rial`, no floating-point or decimal columns, and times only as `timestamptz` `*_at`.
 */
export function checkSchemaConventions(tables: readonly PgTable[]): string[] {
  const problems: string[] = [];
  for (const table of tables) {
    const config = getTableConfig(table);
    const where = (column?: string) => (column ? `${config.name}.${column}` : config.name);

    if (!isSnakeCase(config.name)) problems.push(`${where()}: table name is not snake_case`);

    const id = config.columns.find((c) => c.name === 'id');
    if (!id || !id.primary || id.columnType !== 'PgUUID') {
      problems.push(`${where()}: needs a uuid primary key named id`);
    }
    if (!config.columns.some((c) => c.name === 'created_at')) {
      problems.push(`${where()}: needs created_at`);
    }

    for (const column of config.columns) {
      const at = where(column.name);
      if (!isSnakeCase(column.name)) problems.push(`${at}: column name is not snake_case`);
      if (FLOATING_OR_DECIMAL.has(column.columnType)) {
        problems.push(`${at}: floating-point or decimal column; money is bigint *_rial`);
      }
      if (column.name.endsWith('_rial') && column.columnType !== 'PgBigInt64') {
        problems.push(`${at}: *_rial must be bigint read as a JS bigint`);
      }
      if (TIMESTAMP.has(column.columnType)) {
        const withTimezone = (column as unknown as { withTimezone?: boolean }).withTimezone;
        if (withTimezone !== true) problems.push(`${at}: timestamp without time zone`);
        if (!column.name.endsWith('_at')) problems.push(`${at}: timestamp name must end in _at`);
      }
      if (column.name.endsWith('_at') && !TIMESTAMP.has(column.columnType)) {
        problems.push(`${at}: *_at must be timestamptz`);
      }
    }
  }
  return problems;
}
