import { describe, expect, it } from 'vitest';
import {
  COLORS,
  contrastPairs,
  contrastRatio,
  DARK_COLORS,
  TILE_COLORS,
  tokenCss,
  type Tone,
} from './tokens.js';

describe('contrastRatio (WCAG 2.2)', () => {
  it('matches the known extremes', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBe(1);
  });
});

describe.each(['panel', 'patient'] as Tone[])('the %s colors meet WCAG 2.2 AA', (tone) => {
  it.each(contrastPairs(COLORS[tone]))('$name ≥ $min', ({ fg, bg, min }) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});

describe.each(['panel', 'patient'] as Tone[])('the dark %s colors meet WCAG 2.2 AA', (tone) => {
  it.each(contrastPairs(DARK_COLORS[tone]))('$name ≥ $min', ({ fg, bg, min }) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});

describe('the service desk colors carry a white glyph', () => {
  it.each(Object.entries(TILE_COLORS))('%s ≥ 4.5', (_, color) => {
    expect(contrastRatio('#FFFFFF', color)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('tokenCss', () => {
  it('defines every color of both tones, and stills motion for who asked', () => {
    const css = tokenCss();
    for (const tone of ['panel', 'patient'] as Tone[]) {
      expect(css).toContain(`[data-tone='${tone}']`);
      expect(css).toContain(`--color-accent: ${COLORS[tone].accent};`);
    }
    expect(css).toContain('--color-on-accent-soft:');
    // The dark theme on the shell beside its tone, and the desk's group colors.
    expect(css).toContain(`[data-theme='dark'][data-tone='patient']`);
    expect(css).toContain(`--color-canvas: ${DARK_COLORS.panel.canvas};`);
    expect(css).toContain(`--color-tile-teal: ${TILE_COLORS.teal};`);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*--duration-base: 0ms/);
    // Nothing is fetched from anywhere (rule 18).
    expect(css).not.toMatch(/url\(|@import|https?:/);
  });
});
