import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * ADR-052 (owner 1405/08/02): every financial signature, and the request before it, asks for the
 * signer's SMS code in the service, before anything is written. The integration tests sign
 * with a real code through the harness, so a service that stopped asking would still pass
 * them; this table is what turns red. Each row is a method that must call
 * `stepUp.assert(...)` for that operation; a new financial signature is added here with it.
 */
const WIRED: readonly (readonly [file: string, method: string, type: string | null])[] = [
  ['catalog/center.service.ts', 'proposeBankAccount', 'bank_account_change'],
  ['catalog/center.service.ts', 'decide', 'bank_account_change'],
  ['catalog/visit-tariff-proposal.service.ts', 'propose', 'visit_tariff'],
  ['catalog/visit-tariff-proposal.service.ts', 'decide', 'visit_tariff'],
  ['config/config.service.ts', 'financialStepUp', 'financial_config'],
  ['config/holiday-batch.service.ts', 'request', 'holidays'],
  ['config/holiday-batch.service.ts', 'decide', 'holidays'],
  ['config/holiday-removal.service.ts', 'request', 'holidays'],
  ['config/holiday-removal.service.ts', 'decide', 'holidays'],
  ['contract/completion.service.ts', 'approve', 'completion_receipt'],
  ['contract/refund-payment.service.ts', 'request', 'refund_payment'],
  ['contract/refund-payment.service.ts', 'approve', 'refund_payment'],
  ['credit/cost-split-review.service.ts', 'record', 'cost_split_review'],
  ['credit/credit-cancellation.service.ts', 'request', 'credit_cancellation'],
  ['credit/credit-cancellation.service.ts', 'approve', 'credit_cancellation'],
  ['credit/credit-decision.service.ts', 'propose', 'credit_decision'],
  ['credit/credit-decision.service.ts', 'confirm', 'credit_decision'],
  ['credit/penalty-override.service.ts', 'request', 'penalty_override'],
  ['credit/penalty-override.service.ts', 'decide', 'penalty_override'],
  ['identity/patient-mobile-staff.service.ts', 'propose', 'patient_mobile'],
  ['identity/patient-mobile-staff.service.ts', 'decide', 'patient_mobile'],
  ['identity/staff-mobile-change.service.ts', 'request', 'approver_mobile'],
  ['identity/staff-mobile-change.service.ts', 'decide', 'approver_mobile'],
  ['identity/totp-reset.service.ts', 'request', 'totp_reset'],
  ['identity/totp-reset.service.ts', 'decide', 'totp_reset'],
  ['instrument/execution.service.ts', 'propose', 'instrument_execution'],
  ['instrument/execution.service.ts', 'approve', 'instrument_execution'],
  ['instrument/execution.service.ts', 'requestRelease', 'instrument_release'],
  ['instrument/execution.service.ts', 'decideRelease', 'instrument_release'],
  ['lead/person-mobile-approval.service.ts', 'proposeAsStaff', 'lead_mobile'],
  ['lead/person-mobile-approval.service.ts', 'decideAsStaff', 'lead_mobile'],
  ['repayment/repayment.service.ts', 'approvePayment', 'installment_payment'],
  ['settlement/cash-service.service.ts', 'record', 'cash_service'],
  ['settlement/cash-service.service.ts', 'decide', 'cash_service'],
  ['settlement/dispute.service.ts', 'resolve', 'dispute_resolution'],
  ['settlement/payout.service.ts', 'approve', 'statement_approval'],
  ['settlement/payout.service.ts', 'export', 'payout_export'],
  ['settlement/payout.service.ts', 'recordTracking', 'payout_confirmation'],
  ['settlement/payout.service.ts', 'confirm', 'payout_confirmation'],
  ['settlement/statement.service.ts', 'cancel', 'statement_cancellation'],
  ['wallet/credit-transfer.service.ts', 'request', 'credit_transfer'],
  ['wallet/credit-transfer.service.ts', 'approve', 'credit_transfer'],
  ['wallet/credit-transfer.service.ts', 'requestRevoke', 'credit_transfer'],
  ['wallet/credit-transfer.service.ts', 'decideRevoke', 'credit_transfer'],
  ['wallet/funding.service.ts', 'request', 'funding'],
  ['wallet/funding.service.ts', 'approve', 'funding'],
  // The type follows the operation (a doctor change or another special operation).
  ['wallet/special-operations.service.ts', 'request', null],
  ['wallet/special-operations.service.ts', 'approve', null],
];

/** Where ConfigService signs: its private financialStepUp, from both steps. */
const CONFIG_CALLERS = ['propose', 'decide'] as const;

const MODULES = resolve(__dirname, '../../src/modules');

/** The step-up calls inside each method of a file: method name → the calls' argument text. */
function stepUpCalls(file: string): Map<string, string[]> {
  const sf = ts.createSourceFile(
    file,
    readFileSync(resolve(MODULES, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const out = new Map<string, string[]>();
  const visit = (node: ts.Node, method: string | null, calls: string[] | null) => {
    let m = method;
    let c = calls;
    if (ts.isMethodDeclaration(node)) {
      m = node.name.getText(sf);
      c = out.get(m) ?? [];
      out.set(m, c);
    }
    if (
      c &&
      ts.isCallExpression(node) &&
      (/^this\.stepUp\??\.assert$/.test(node.expression.getText(sf)) ||
        /\bstepUp\??\.assert$/.test(node.expression.getText(sf)) ||
        node.expression.getText(sf) === 'this.financialStepUp')
    ) {
      c.push(node.getText(sf));
    }
    ts.forEachChild(node, (child) => {
      visit(child, m, c);
    });
  };
  visit(sf, null, null);
  return out;
}

describe('ADR-052: every financial signature asks for the SMS code', () => {
  it.each(WIRED)('%s %s', (file, method, type) => {
    const calls = (stepUpCalls(file).get(method) ?? []).filter((c) => /assert\(/.test(c));
    expect(calls, `${file} ${method} no longer asks for the code`).not.toHaveLength(0);
    if (type) expect(calls.some((c) => c.includes(`type: '${type}'`))).toBe(true);
  });

  it.each(CONFIG_CALLERS)('config.service.ts %s signs a financial setting', (method) => {
    const calls = stepUpCalls('config/config.service.ts').get(method) ?? [];
    expect(calls.some((c) => c.startsWith('this.financialStepUp('))).toBe(true);
  });
});
