import path from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs this app's real eslint.config.mjs, proving the module boundary rule is wired in.
 * The rule itself is unit-tested in packages/config.
 */
const apiRoot = path.resolve(__dirname, '..');
const eslint = new ESLint({
  cwd: apiRoot,
  // The files below are virtual, so type information is unavailable for them.
  overrideConfig: tseslint.configs.disableTypeChecked,
});

async function boundaryErrors(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(apiRoot, file) });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'sepehr/no-cross-module-import')
    .map((m) => m.message);
}

describe('module boundaries in apps/api', () => {
  // Loading the config and its plugins is the slow part, not what is tested: done once here,
  // with its own time, so a busy machine does not time the first case out.
  beforeAll(async () => {
    await eslint.calculateConfigForFile(path.join(apiRoot, 'src/main.ts'));
    await boundaryErrors('src/main.ts', 'export {};');
  }, 60_000);

  it('rejects a deep import from another module', async () => {
    const errors = await boundaryErrors(
      'src/modules/booking/booking.service.ts',
      "import { LedgerService } from '../ledger/ledger.service';\nexport { LedgerService };\n",
    );
    expect(errors).toEqual([
      "Module 'booking' must not import from module 'ledger'. Use interfaces and tokens from @sepehr/contracts, or a domain event.",
    ]);
  });

  it("rejects an import from another module's index.ts", async () => {
    const errors = await boundaryErrors(
      'src/modules/booking/booking.service.ts',
      "import { x } from '../ledger';\nexport { x };\n",
    );
    expect(errors).toHaveLength(1);
  });

  it('allows imports within a module and from @sepehr/contracts', async () => {
    const errors = await boundaryErrors(
      'src/modules/booking/booking.service.ts',
      "import { Slot } from './domain/slot';\nimport { API_MODULES } from '@sepehr/contracts';\nexport { Slot, API_MODULES };\n",
    );
    expect(errors).toEqual([]);
  });
});
