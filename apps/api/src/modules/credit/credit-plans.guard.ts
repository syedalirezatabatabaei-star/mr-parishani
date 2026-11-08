import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { CreditPlans } from '@sepehr/contracts';
import { CONFIG_GUARDS, type ConfigGuardRegistry } from '../../common/config/config-guards.port';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';

/**
 * ADR-035 (owner, 1405/07/11): every plan added from now on rounds its shares to whole
 * tomans (`percentRoundingRial: '10'`). A plan already in force keeps what it had, so no
 * case changes under it (rule 16). Checked when the plans are proposed and again when they
 * are approved, against the plans in force at that moment.
 */
@Injectable()
export class CreditPlansGuard implements OnModuleInit {
  constructor(
    @Inject(CONFIG_GUARDS) private readonly guards: ConfigGuardRegistry,
    @Inject(CONFIG) private readonly config: ConfigPort,
  ) {}

  onModuleInit(): void {
    this.guards.register('credit.plans', (plans) => this.check(plans));
  }

  async check(plans: CreditPlans) {
    const inForce = new Set(
      (await this.config.resolve('credit.plans')).value.plans.map((p) => p.code),
    );
    const unrounded = plans.plans
      .filter((p) => !inForce.has(p.code) && p.percentRoundingRial !== '10')
      .map((p) => p.code);
    if (unrounded.length === 0) return null;
    return { error: 'plan_rounding_required', details: { plans: unrounded } };
  }
}
