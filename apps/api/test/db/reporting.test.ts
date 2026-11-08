import { describe, expect, it } from 'vitest';
import { reportingUrlFromEnv } from '../../src/db/reporting.module';

const primary = 'postgres://sepehr_app:x@127.0.0.1:5432/sepehr';
const replica = 'postgres://sepehr_report:x@replica:5432/sepehr';

describe('the reporting connection (ADR-012, ADR-020)', () => {
  it('uses REPORTING_DATABASE_URL when set', () => {
    expect(reportingUrlFromEnv({ REPORTING_DATABASE_URL: replica, DATABASE_URL: primary })).toEqual(
      {
        url: replica,
        fallback: false,
      },
    );
  });

  it('is required in production: reports never run on the primary there', () => {
    expect(() => reportingUrlFromEnv({ NODE_ENV: 'production', DATABASE_URL: primary })).toThrow(
      'REPORTING_DATABASE_URL is not set',
    );
  });

  it('falls back to the primary elsewhere, saying so', () => {
    expect(reportingUrlFromEnv({ NODE_ENV: 'development', DATABASE_URL: primary })).toEqual({
      url: primary,
      fallback: true,
    });
  });
});
