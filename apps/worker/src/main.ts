// Telemetry first: pg, ioredis and Nest must load after the instrumentation is in place,
// hence the dynamic import of everything else.
import { startTelemetry } from '@sepehr/api/telemetry';

const telemetry = startTelemetry('sepehr-worker');
const { startWorker } = await import('./worker.js');

const worker = await startWorker();
console.log('worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void worker
      .stop()
      .then(() => telemetry?.shutdown())
      .then(() => process.exit(0));
  });
}
