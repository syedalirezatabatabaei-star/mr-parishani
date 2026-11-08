import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, newNonce } from './csp.js';

const directives = (csp: string) =>
  new Map(
    csp.split('; ').map((d) => {
      const [name = '', ...values] = d.split(' ');
      return [name, values] as const;
    }),
  );

describe('contentSecurityPolicy (rules 17–20)', () => {
  it('allows nothing outside the own origin in production', () => {
    const csp = contentSecurityPolicy({ nonce: 'abc', development: false });
    const d = directives(csp);
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('script-src')).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
    expect(d.get('style-src')).toEqual(["'self'", "'nonce-abc'"]);
    expect(d.get('connect-src')).toEqual(["'self'"]);
    expect(d.get('font-src')).toEqual(["'self'"]);
    expect(d.get('frame-src')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.has('upgrade-insecure-requests')).toBe(true);
    // No host other than the app itself is named anywhere.
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).not.toContain('unsafe-eval');
  });

  it('development adds eval, inline dev styles and the dev server socket only', () => {
    const d = directives(contentSecurityPolicy({ nonce: 'n', development: true }));
    expect(d.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(d.get('script-src')).toContain("'unsafe-eval'");
    expect(d.get('connect-src')).toEqual(["'self'", 'ws:']);
    expect(d.has('upgrade-insecure-requests')).toBe(false);
  });

  it('names the file store and allowed frames only when given', () => {
    const d = directives(
      contentSecurityPolicy({
        nonce: 'n',
        development: false,
        mediaOrigin: 'https://files.sepehr.example',
        frameOrigins: ['https://www.aparat.com'],
      }),
    );
    expect(d.get('img-src')).toContain('https://files.sepehr.example');
    expect(d.get('media-src')).toContain('https://files.sepehr.example');
    expect(d.get('frame-src')).toEqual(['https://www.aparat.com']);
    expect(d.get('connect-src')).toEqual(["'self'"]);
  });
});

describe('newNonce', () => {
  it('is fresh every time and base64 of 16 bytes', () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(atob(a)).toHaveLength(16);
  });
});
