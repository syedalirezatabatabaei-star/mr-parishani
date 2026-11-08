/**
 * OpenTelemetry for the API and the worker (task 0-7): traces and metrics over OTLP/HTTP
 * to a self-hosted collector (ADR-008), at OTEL_EXPORTER_OTLP_ENDPOINT. Unset means off:
 * nothing is exported anywhere. Must start before pg, ioredis, http and Nest are loaded,
 * so this file imports nothing of the application.
 *
 * No personal data leaves the process (rule 30): Postgres spans carry statements without
 * parameters, Redis spans only the command name (keys hold mobiles), and outgoing HTTP
 * is not traced at all (the SMS provider's URL holds its API key).
 */
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface Telemetry {
  shutdown(): Promise<void>;
}

/** Starts OpenTelemetry if OTEL_EXPORTER_OTLP_ENDPOINT is set; returns null otherwise. */
export function startTelemetry(
  serviceName: 'sepehr-api' | 'sepehr-worker',
  env: NodeJS.ProcessEnv = process.env,
): Telemetry | null {
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim().replace(/\/+$/, '');
  if (!endpoint) return null;
  if (!/^https?:\/\/[^/]+/.test(endpoint)) {
    throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL of the collector');
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 30_000,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({ ignoreOutgoingRequestHook: () => true }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
      new NestInstrumentation(),
    ],
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
