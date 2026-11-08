import { describe, expect, it } from 'vitest';
import {
  PROFILE_VERSION_TRANSITIONS,
  profileContentSchema,
  profileSlugSchema,
} from './profiles.js';

describe('profileSlugSchema (doc 08 §10: a Latin address)', () => {
  it('takes lower-case hyphenated words and folds case', () => {
    expect(profileSlugSchema.parse('dr-negar-zarrinmakan')).toBe('dr-negar-zarrinmakan');
    expect(profileSlugSchema.parse('  Dr-Ali-2 ')).toBe('dr-ali-2');
  });

  it('refuses Persian letters, spaces, edge or double hyphens, and extreme lengths', () => {
    for (const bad of [
      'دکتر-علی',
      'dr ali',
      '-dr',
      'dr-',
      'dr--ali',
      'dr_ali',
      'ab',
      'a'.repeat(81),
    ]) {
      expect(profileSlugSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('profileContentSchema', () => {
  it('normalizes text (rule 23) and accepts an Aparat video id', () => {
    expect(
      profileContentSchema.parse({
        specialtyTitle: 'متخصص ارتودنسي',
        history: ['دكترای تخصصی ۱۳۹۰'],
        video: { hosting: 'aparat', aparatId: 'Ab12x' },
      }),
    ).toEqual({
      specialtyTitle: 'متخصص ارتودنسی',
      history: ['دکترای تخصصی 1390'],
      video: { hosting: 'aparat', aparatId: 'Ab12x' },
    });
  });

  it('refuses plain http links and an unknown social network', () => {
    const social = (url: string, kind = 'instagram') =>
      profileContentSchema.safeParse({ socials: [{ kind, url }] }).success;
    expect(social('https://instagram.com/dr')).toBe(true);
    expect(social('http://instagram.com/dr')).toBe(false);
    expect(social('javascript:alert(1)')).toBe(false);
    expect(social('https://x.com/dr', 'twitter')).toBe(false);
  });
});

describe('PROFILE_VERSION_TRANSITIONS (doc 08 §10)', () => {
  it('is draft → in_review → published | rejected, and nothing leaves a decision', () => {
    expect(PROFILE_VERSION_TRANSITIONS).toEqual({
      draft: ['in_review'],
      in_review: ['published', 'rejected'],
      published: [],
      rejected: [],
    });
  });
});
