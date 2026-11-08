import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { OUTBOX_QUEUE, SMS_QUEUE } from '@sepehr/contracts';
import { describe, expect, it } from 'vitest';
import { ALERT_CODES } from '../../src/infra/ops/alerts';
import { MAINTENANCE_QUEUE } from '../../src/infra/outbox/worker-runtime';

/**
 * The Prometheus rules (task 10-3) against the code that feeds them: promtool is not
 * available offline (ops/monitoring/README.md), so this at least proves every sepehr_*
 * metric, queue and alert code a rule names is one the API and worker really export. A
 * renamed gauge or alert code would otherwise leave its rule silently matching nothing.
 */
const repo = path.resolve(__dirname, '../../../..');
const rulesDir = path.join(repo, 'ops/alerts');
const ruleFiles = readdirSync(rulesDir).filter((f) => f.endsWith('.yml'));
/** The rule files, without comment lines (which name metrics in prose). */
const rules = ruleFiles.map((f) => ({
  file: f,
  text: readFileSync(path.join(rulesDir, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n'),
}));

/** OpenTelemetry instrument → the name the collector's Prometheus exporter gives it. */
function exportedNames(): Set<string> {
  const names = new Set<string>();
  for (const file of [
    'src/infra/ops/queue-monitor.ts',
    'src/infra/ops/alerts.ts',
    'src/infra/ops/sms-credit.ts',
  ]) {
    const source = readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    const instrument = /\.create(ObservableGauge|Counter)\(\s*'([^']+)'\s*(?:,\s*\{([^}]*)\})?/g;
    for (const [, kind, name = '', options = ''] of source.matchAll(instrument)) {
      const unit = /unit:\s*'(\w+)'/.exec(options)?.[1];
      let exported = name.replaceAll('.', '_');
      if (unit === 's') exported += '_seconds';
      if (kind === 'Counter') exported += '_total';
      names.add(exported);
    }
  }
  return names;
}

/**
 * Written by the backup job to node_exporter's textfile collector, not by the app
 * (ops/monitoring/README.md, «پشتیبان»).
 */
const TEXTFILE = new Map([
  ['sepehr_backup_last_success_timestamp_seconds', ['wal', 'base', 'second_copy']],
]);

/** Every `sepehr_*{...}` in the rules, with its label matchers. */
function references() {
  const found: { file: string; metric: string; labels: Map<string, string[]> }[] = [];
  for (const { file, text } of rules) {
    for (const [, metric = '', selector = ''] of text.matchAll(/\b(sepehr_\w+)(?:\{([^}]*)\})?/g)) {
      const labels = new Map<string, string[]>();
      for (const [, label = '', op, value = ''] of selector.matchAll(
        /(\w+)\s*(=~|=)\s*"([^"]*)"/g,
      )) {
        labels.set(label, op === '=~' ? value.split('|') : [value]);
      }
      found.push({ file, metric, labels });
    }
  }
  return found;
}

describe('the alert rules name only what the code exports (task 10-3)', () => {
  const exported = exportedNames();
  const queues = [OUTBOX_QUEUE, SMS_QUEUE, MAINTENANCE_QUEUE];

  it('finds the instruments and the rule files', () => {
    expect(exported).toEqual(
      new Set([
        'sepehr_outbox_pending',
        'sepehr_outbox_oldest_pending_age_seconds',
        'sepehr_queue_jobs',
        'sepehr_alerts_active',
        'sepehr_alerts_raised_total',
        'sepehr_sms_credit_remaining_rial',
        'sepehr_sms_credit_low',
      ]),
    );
    expect(ruleFiles.sort()).toEqual(['platform.yml', 'queues.yml']);
    expect(references().length).toBeGreaterThan(10);
  });

  it('every sepehr_* metric in a rule is exported, with label values that exist', () => {
    for (const { file, metric, labels } of references()) {
      const where = `${file}: ${metric}`;
      const kinds = TEXTFILE.get(metric);
      if (kinds) {
        for (const kind of labels.get('kind') ?? []) expect(kinds, where).toContain(kind);
        continue;
      }
      expect(exported, where).toContain(metric);
      for (const code of labels.get('code') ?? []) expect(ALERT_CODES, where).toContain(code);
      for (const queue of labels.get('queue') ?? []) expect(queues, where).toContain(queue);
      for (const state of labels.get('state') ?? []) {
        expect(['waiting', 'active', 'delayed', 'failed'], where).toContain(state);
      }
    }
  });

  it('every reconciliation alert code is watched by a rule', () => {
    const watched = new Set(references().flatMap((r) => r.labels.get('code') ?? []));
    for (const code of ALERT_CODES.filter(
      (c) => !c.startsWith('outbox_') && !c.startsWith('queue_'),
    )) {
      expect(watched, code).toContain(code);
    }
  });

  it('every rule has a severity and a summary, and prometheus.yml loads both files', () => {
    for (const { file, text } of rules) {
      const blocks = text.split(/\n\s*- alert: /).slice(1);
      expect(blocks.length, file).toBeGreaterThan(0);
      for (const block of blocks) {
        const name = block.split('\n')[0] ?? '';
        expect(block, `${file}: ${name}`).toMatch(/severity: (critical|warning)/);
        expect(block, `${file}: ${name}`).toMatch(/summary: /);
      }
    }
    const config = readFileSync(path.join(repo, 'ops/monitoring/prometheus.yml'), 'utf8');
    for (const f of ruleFiles) expect(config).toContain(`/etc/prometheus/rules/${f}`);
  });
});
