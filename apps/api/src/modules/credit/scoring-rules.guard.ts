import { readFileSync } from 'node:fs';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { runGoldenCases, type GoldenFile, type ScoringRuleset } from '@sepehr/contracts';
import { CONFIG_GUARDS, type ConfigGuardRegistry } from '../../common/config/config-guards.port';

/** At most this many differences are named in the refusal; the count is always given. */
const SHOWN_FAILURES = 20;

/** The golden cases of the client's workbook (task 3-1), shipped with @sepehr/contracts. */
export function loadGoldenCases(): GoldenFile {
  const file = require.resolve('@sepehr/contracts/fixtures/scoring/golden-v1.json');
  return JSON.parse(readFileSync(file, 'utf8')) as GoldenFile;
}

/**
 * No scoring ruleset is proposed or approved unless it gives what Excel gave on every
 * golden case (doc 03 §8-3; doc 10 §10 test 1; task 3-2). A second person's approval
 * comes from the key being sensitive; this is the other half of «activation».
 */
@Injectable()
export class ScoringRulesGuard implements OnModuleInit {
  private readonly golden = loadGoldenCases();

  constructor(@Inject(CONFIG_GUARDS) private readonly guards: ConfigGuardRegistry) {}

  onModuleInit(): void {
    this.guards.register('credit.scoring_ruleset', (rules) => this.check(rules));
  }

  check(rules: ScoringRuleset) {
    const failures = runGoldenCases(rules, this.golden);
    if (failures.length === 0) return null;
    return {
      error: 'golden_cases_failed',
      details: {
        workbook: this.golden.source.workbook,
        failed: new Set(failures.map((f) => f.id)).size,
        of: this.golden.cases.length,
        failures: failures.slice(0, SHOWN_FAILURES),
      },
    };
  }
}
