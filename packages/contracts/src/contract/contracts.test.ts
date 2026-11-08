import { describe, expect, it } from 'vitest';
import {
  contractTemplateFields,
  contractTemplateProblems,
  fillContractTemplate,
} from './contracts.js';

describe('contract templates (doc 12 §2)', () => {
  it('finds the fields a body names, once each', () => {
    expect(
      contractTemplateFields(
        '{{loan.amount}} و {{ loan.amount }} و {{cancellation.penaltyPercent}}',
      ),
    ).toEqual(['loan.amount', 'cancellation.penaltyPercent']);
  });

  it('requires the cancellation penalty and knows every field (doc 12 §9 test 15)', () => {
    expect(contractTemplateProblems('مبلغ {{loan.amount}}')).toEqual({
      unknown: [],
      missing: ['cancellation.penaltyPercent'],
    });
    expect(
      contractTemplateProblems('{{cancellation.penaltyPercent}} {{patient.diagnosis}}'),
    ).toEqual({ unknown: ['patient.diagnosis'], missing: [] });
    expect(contractTemplateProblems('{{cancellation.penaltyPercent}}')).toEqual({
      unknown: [],
      missing: [],
    });
  });

  it('fills known fields and leaves the rest as written', () => {
    expect(fillContractTemplate('{{a.b}} و {{c.d}}', { 'a.b': 'یک' })).toBe('یک و {{c.d}}');
  });
});
