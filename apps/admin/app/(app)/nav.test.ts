import { SHORT_LABEL_MAX } from '@sepehr/ui';
import { describe, expect, it } from 'vitest';
import { ADMIN_SECTIONS } from './nav';

describe('the bottom bar’s labels (owner 1405/08/11)', () => {
  it('are short, distinct, and every section has one', () => {
    for (const s of ADMIN_SECTIONS) {
      expect(s.shortLabel.length, s.href).toBeLessThanOrEqual(SHORT_LABEL_MAX);
      expect(s.shortLabel.trim(), s.href).not.toBe('');
    }
    const labels = ADMIN_SECTIONS.map((s) => s.shortLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
