import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { contractTemplateProblems, type ContractTemplate } from '@sepehr/contracts';
import { CONFIG_GUARDS, type ConfigGuardRegistry } from '../../common/config/config-guards.port';
import { INCOME_ENTITIES, isIncomeEntity } from '../../common/ledger/income-entities';

/**
 * No contract template is proposed or approved without the cancellation penalty in its
 * text (doc 12 §2: so it can be claimed; §9 test 15), nor with a field no contract fills,
 * nor with a lender that may not earn income (ADR-007: aramesh only). The second person's
 * approval comes from the key being sensitive.
 */
@Injectable()
export class ContractTemplateGuard implements OnModuleInit {
  constructor(@Inject(CONFIG_GUARDS) private readonly guards: ConfigGuardRegistry) {}

  onModuleInit(): void {
    this.guards.register('contract.loan_template', (template) => this.check(template));
  }

  check(template: ContractTemplate) {
    // The lender earns the fees: only an income entity of ADR-007 (version one: aramesh).
    if (!isIncomeEntity(template.lender.entityId)) {
      return {
        error: 'lender_not_allowed',
        details: { entityId: template.lender.entityId, allowed: [...INCOME_ENTITIES] },
      };
    }
    const { unknown, missing } = contractTemplateProblems(template.body);
    if (unknown.length === 0 && missing.length === 0) return null;
    return { error: 'contract_template_invalid', details: { unknown, missing } };
  }
}
