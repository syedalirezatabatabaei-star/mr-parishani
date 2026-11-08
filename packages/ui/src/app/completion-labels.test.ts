import { describe, expect, it } from 'vitest';
import { missingLabel } from './completion-labels.js';

describe('missingLabel', () => {
  it('names the cheque rule’s shortfalls (owner 1405/07/29, ج۵) without its numbers', () => {
    expect(missingLabel('cheque:borrower')).toBe('حداقل چک قسط وام‌گیرنده (بررسی‌شده)');
    expect(missingLabel('cheque:guarantor:0')).toBe('حداقل مبلغ چک ضمانت ضامن ۱ (بررسی‌شده)');
    expect(missingLabel('cheque:guarantor:1')).toBe('حداقل مبلغ چک ضمانت ضامن ۲ (بررسی‌شده)');
  });

  it('keeps the earlier codes', () => {
    expect(missingLabel('delivery')).toBe('بررسی کامل مدارک فیزیکی');
    expect(missingLabel('condition:0')).toBe('شرط ۱ تصمیم');
    expect(missingLabel('receipt:origination_fee')).toBe('تأیید فیش هزینه تشکیل پرونده');
  });
});
