import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Task 0-6: no consumer reads configuration from the tables. Only the config module (and
 * the schema index that drizzle-kit reads) may name them; everyone else uses the CONFIG
 * port. The lint rule already forbids importing the module's schema from another module;
 * this also catches raw SQL and code outside the modules.
 */
const repo = path.resolve(__dirname, '..', '..', '..', '..');
const roots = ['apps/api/src', 'apps/worker/src'];
const allowed = new Set(['apps/api/src/db/schema.ts']);
const allowedDir = 'apps/api/src/modules/config/';
// The holiday tables too (task 2-1): other modules use the HOLIDAY_CALENDAR port.
const forbidden =
  /\bconfig_values\b|\bconfig_keys\b|\bconfigValues\b|\bconfigKeys\b|config\.schema|\badmin_notices\b|\badminNotices\b|(?:FROM|JOIN|INTO|UPDATE)\s+"?holidays\b/;

function files(dir: string): string[] {
  return readdirSync(path.join(repo, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return files(relative);
    return /\.(ts|js|sql)$/.test(entry.name) ? [relative] : [];
  });
}

describe('configuration is read only through the CONFIG port', () => {
  it('no file outside the config module names its tables', () => {
    const offenders = roots
      .flatMap(files)
      .filter((file) => !allowed.has(file) && !file.startsWith(allowedDir))
      .filter((file) => forbidden.test(readFileSync(path.join(repo, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('would catch an offender', () => {
    expect(forbidden.test('db.execute(sql`SELECT value FROM config_values`)')).toBe(true);
    expect(forbidden.test("this.config.resolve('audit.retention')")).toBe(false);
    expect(forbidden.test('SELECT 1 FROM holidays WHERE')).toBe(true);
    expect(forbidden.test('moves a due day off holidays')).toBe(false);
  });
});

describe('the ledger is read and written only through the LEDGER port', () => {
  const ledgerTables =
    /\bledger_entries\b|\bjournal_entries\b|\bledger_accounts\b|\baccount_balances\b|\bledger_balance_applications\b|\bledger_reconciliation_runs\b|\bledger_discrepancies\b|\bledger_daily_reports\b/;

  it('no file outside the ledger module names its tables', () => {
    const offenders = roots
      .flatMap(files)
      .filter((file) => !file.startsWith('apps/api/src/modules/ledger/'))
      // The partition maintenance names the table only to keep its months ahead.
      .filter((file) => file !== 'apps/api/src/infra/ops/partition-maintenance.ts')
      .filter((file) => ledgerTables.test(readFileSync(path.join(repo, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('the credit purse is reached only through the WALLET port', () => {
  const walletTables = /\bcredit_purses\b|\bpurse_operations\b/;

  it('no file outside the wallet module names its tables', () => {
    const offenders = roots
      .flatMap(files)
      .filter((file) => !file.startsWith('apps/api/src/modules/wallet/'))
      .filter((file) => walletTables.test(readFileSync(path.join(repo, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('the purse is «کیف اعتبار», never «کیف پول» (build plan 1-2)', () => {
  it('appears in no code or interface text of any app or package', () => {
    const sources = [
      'apps/api/src',
      'apps/worker/src',
      'apps/web/app',
      'apps/admin/app',
      'packages/contracts/src',
      'packages/ui/src',
    ];
    const offenders = sources
      .flatMap(files)
      .concat(sources.flatMap((dir) => filesWith(dir, /\.(tsx|json)$/)))
      .filter((file) => readFileSync(path.join(repo, file), 'utf8').includes('کیف پول'));
    expect(offenders).toEqual([]);
  });
});

function filesWith(dir: string, pattern: RegExp): string[] {
  return readdirSync(path.join(repo, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return filesWith(relative, pattern);
    return pattern.test(entry.name) ? [relative] : [];
  });
}

describe('repayment is reached only through the REPAYMENT port', () => {
  // The plain words also occur in prose; for them, only SQL use counts.
  const repaymentTables =
    /\binstallment_schedules\b|\bpayment_allocations\b|\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:installments|payments)\b/i;

  it('would catch an offender, and not prose', () => {
    expect(repaymentTables.test('SELECT * FROM installments WHERE 1')).toBe(true);
    expect(repaymentTables.test('INSERT INTO payments (amount_rial)')).toBe(true);
    expect(repaymentTables.test('spreading it over the installments instead')).toBe(false);
  });

  it('no file outside the repayment module names its tables', () => {
    const offenders = roots
      .flatMap(files)
      .filter((file) => !file.startsWith('apps/api/src/modules/repayment/'))
      .filter((file) => repaymentTables.test(readFileSync(path.join(repo, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('centers are reached only through the catalog module and CENTER_DIRECTORY', () => {
  // The plain words also occur in prose; for them, only SQL use counts.
  const catalogTables =
    /\bcenter_treatment_fields\b|\bcenter_documents\b|\bcenter_status_changes\b|\bcenter_change_requests\b|\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:centers|branches)\b/;

  it('would catch an offender, and not prose', () => {
    expect(catalogTables.test('SELECT status FROM centers WHERE')).toBe(true);
    expect(catalogTables.test('moves a doctor between branches')).toBe(false);
  });

  it('no file outside the catalog module names its tables', () => {
    const offenders = roots
      .flatMap(files)
      .filter((file) => !allowed.has(file) && !file.startsWith('apps/api/src/modules/catalog/'))
      .filter((file) => catalogTables.test(readFileSync(path.join(repo, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
