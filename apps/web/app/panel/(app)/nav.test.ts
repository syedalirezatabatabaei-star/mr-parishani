import { SHORT_LABEL_MAX } from '@sepehr/ui';
import { describe, expect, it } from 'vitest';
import { PATIENT_SECTIONS } from '../../(patient)/me-nav';
import { PANEL_SECTIONS } from './nav';

describe('the bottom bar’s labels (owner 1405/08/11)', () => {
  it.each([
    ['center panel', PANEL_SECTIONS],
    ['patient', PATIENT_SECTIONS],
  ] as const)('of the %s are short and distinct', (_, sections) => {
    for (const s of sections) {
      expect(s.shortLabel.length, s.href).toBeLessThanOrEqual(SHORT_LABEL_MAX);
    }
    const labels = sections.map((s) => s.shortLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
