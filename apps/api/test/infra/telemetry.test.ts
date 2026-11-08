import { describe, expect, it } from 'vitest';
import { startTelemetry } from '../../src/infra/telemetry';

describe('OpenTelemetry', () => {
  it('is off, exporting nothing anywhere, unless a collector endpoint is set', () => {
    expect(startTelemetry('sepehr-api', {})).toBeNull();
    expect(startTelemetry('sepehr-worker', { OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBeNull();
  });

  it('refuses an endpoint that is not an http(s) URL', () => {
    expect(() =>
      startTelemetry('sepehr-api', { OTEL_EXPORTER_OTLP_ENDPOINT: 'collector:4318' }),
    ).toThrow('must be an http(s) URL');
  });
});
