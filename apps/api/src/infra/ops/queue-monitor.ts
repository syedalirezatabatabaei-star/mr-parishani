import { Inject, Injectable } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { CONFIG, type ConfigPort } from '../../common/config/config.port';
import { DATABASE, type Database } from '../../db/database.module';
import { ALERT_SINK, type Alert, type AlertSink } from './alerts';

export interface QueueCounts {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
}

export interface MonitorSnapshot {
  readonly outboxPending: number;
  readonly outboxOldestPendingSeconds: number;
  readonly queues: Readonly<Record<string, QueueCounts>>;
  readonly alerts: readonly Alert[];
}

/**
 * Queue health (task 0-7): the outbox backlog and the age of its oldest unpublished
 * event, and each queue's job counts. Each check compares them with the thresholds of
 * `ops.outbox_alert_thresholds` and `ops.queue_alert_thresholds`, raises an alert for
 * every threshold crossed, and keeps the numbers for the OpenTelemetry gauges (which
 * Grafana alerts on too).
 */
@Injectable()
export class QueueMonitor {
  private last: MonitorSnapshot | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: ConfigPort,
    @Inject(ALERT_SINK) private readonly alerts: AlertSink,
  ) {
    const meter = metrics.getMeter('sepehr.ops');
    meter
      .createObservableGauge('sepehr.outbox.pending', { description: 'Unpublished outbox events' })
      .addCallback((result) => {
        if (this.last) result.observe(this.last.outboxPending);
      });
    meter
      .createObservableGauge('sepehr.outbox.oldest_pending_age', {
        description: 'Age of the oldest unpublished outbox event',
        unit: 's',
      })
      .addCallback((result) => {
        if (this.last) result.observe(this.last.outboxOldestPendingSeconds);
      });
    meter
      .createObservableGauge('sepehr.queue.jobs', { description: 'Jobs per queue and state' })
      .addCallback((result) => {
        const queues: Readonly<Record<string, QueueCounts>> = this.last?.queues ?? {};
        for (const [queue, counts] of Object.entries(queues)) {
          for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
            result.observe(counts[state], { queue, state });
          }
        }
      });
    meter
      .createObservableGauge('sepehr.alerts.active', {
        description: 'Alerts raised by the last check',
      })
      .addCallback((result) => {
        for (const alert of this.last?.alerts ?? []) result.observe(1, { code: alert.code });
      });
  }

  async check(queues: readonly Queue[], now = new Date()): Promise<MonitorSnapshot> {
    const [{ value: outboxLimits }, { value: queueLimits }] = await Promise.all([
      this.config.resolve('ops.outbox_alert_thresholds', {}, now),
      this.config.resolve('ops.queue_alert_thresholds', {}, now),
    ]);
    const stats = await this.db.execute<{ pending: number; oldest: number | null }>(sql`
      SELECT count(*)::int AS pending,
             extract(epoch FROM ${now}::timestamptz - min(created_at))::float8 AS oldest
      FROM outbox_events WHERE published_at IS NULL
    `);
    const pending = stats.rows[0]?.pending ?? 0;
    const oldest = Math.max(0, Math.floor(stats.rows[0]?.oldest ?? 0));

    const counts: Record<string, QueueCounts> = {};
    for (const queue of queues) {
      const c = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      counts[queue.name] = {
        waiting: c['waiting'] ?? 0,
        active: c['active'] ?? 0,
        delayed: c['delayed'] ?? 0,
        failed: c['failed'] ?? 0,
      };
    }

    const alerts: Alert[] = [];
    if (pending > outboxLimits.maxPending) {
      alerts.push({
        code: 'outbox_backlog',
        message: `${String(pending)} unpublished outbox events (limit ${String(outboxLimits.maxPending)})`,
      });
    }
    if (oldest > outboxLimits.maxOldestPendingSeconds) {
      alerts.push({
        code: 'outbox_stale',
        message: `oldest unpublished outbox event is ${String(oldest)}s old (limit ${String(outboxLimits.maxOldestPendingSeconds)}s)`,
      });
    }
    for (const [name, c] of Object.entries(counts)) {
      if (c.waiting > queueLimits.maxWaiting) {
        alerts.push({
          code: 'queue_backlog',
          message: `queue ${name} has ${String(c.waiting)} waiting jobs (limit ${String(queueLimits.maxWaiting)})`,
        });
      }
      if (c.failed > queueLimits.maxFailed) {
        alerts.push({
          code: 'queue_failed',
          message: `queue ${name} has ${String(c.failed)} failed jobs (limit ${String(queueLimits.maxFailed)})`,
        });
      }
    }

    this.last = {
      outboxPending: pending,
      outboxOldestPendingSeconds: oldest,
      queues: counts,
      alerts,
    };
    for (const alert of alerts) await this.alerts.raise(alert);
    return this.last;
  }
}
