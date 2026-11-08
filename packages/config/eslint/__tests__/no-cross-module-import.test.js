// @ts-check
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { noCrossModuleImport } from '../rules/no-cross-module-import.js';

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const MODULES = '/repo/apps/api/src/modules';
const bookingFile = `${MODULES}/booking/booking.service.ts`;
const nestedBookingFile = `${MODULES}/booking/domain/slot.ts`;

/** @param {string} to */
const crossModule = (to) => [{ messageId: 'crossModule', data: { from: 'booking', to } }];

ruleTester.run('no-cross-module-import', noCrossModuleImport, {
  valid: [
    // Inside the same module.
    { filename: bookingFile, code: "import { Slot } from './domain/slot';" },
    { filename: nestedBookingFile, code: "import { BookingService } from '../booking.service';" },
    { filename: nestedBookingFile, code: "import { x } from '../index';" },
    // Shared contracts and third-party packages.
    { filename: bookingFile, code: "import type { LedgerPort } from '@sepehr/contracts';" },
    { filename: bookingFile, code: "import { Injectable } from '@nestjs/common';" },
    // Files outside modules (e.g. app.module.ts) may import modules to register them.
    {
      filename: '/repo/apps/api/src/app.module.ts',
      code: "import { LedgerModule } from './modules/ledger/ledger.module';",
    },
  ],
  invalid: [
    // Deep import into another module.
    {
      filename: bookingFile,
      code: "import { LedgerService } from '../ledger/ledger.service';",
      errors: crossModule('ledger'),
    },
    // Even through the other module's public index.ts.
    {
      filename: bookingFile,
      code: "import { x } from '../ledger';",
      errors: crossModule('ledger'),
    },
    {
      filename: bookingFile,
      code: "import { x } from '../ledger/index';",
      errors: crossModule('ledger'),
    },
    // Type-only imports are imports too.
    {
      filename: nestedBookingFile,
      code: "import type { Wallet } from '../../wallet/wallet.entity';",
      errors: crossModule('wallet'),
    },
    // Re-exports, dynamic import and require.
    {
      filename: bookingFile,
      code: "export * from '../ledger/ledger.service';",
      errors: crossModule('ledger'),
    },
    {
      filename: bookingFile,
      code: "export { LedgerService } from '../ledger/ledger.service';",
      errors: crossModule('ledger'),
    },
    {
      filename: bookingFile,
      code: "const m = import('../ledger/ledger.service');",
      errors: crossModule('ledger'),
    },
    {
      filename: bookingFile,
      code: "const m = require('../ledger/ledger.service');",
      errors: crossModule('ledger'),
    },
    {
      filename: bookingFile,
      code: "import m = require('../ledger/ledger.service');",
      errors: crossModule('ledger'),
    },
    // Path aliases.
    {
      filename: bookingFile,
      code: "import { x } from 'src/modules/ledger/ledger.service';",
      errors: crossModule('ledger'),
    },
    // Windows paths.
    {
      filename: 'C:\\repo\\apps\\api\\src\\modules\\booking\\booking.service.ts',
      code: "import { x } from '../ledger';",
      errors: crossModule('ledger'),
    },
  ],
});
