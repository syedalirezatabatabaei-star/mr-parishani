/** Side-effect import for main.ts: starts OpenTelemetry for the API, if configured. */
import { startTelemetry } from './telemetry';

startTelemetry('sepehr-api');
