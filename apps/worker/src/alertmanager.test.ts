import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALERTMANAGER_PATH,
  alertmanagerReceiverFromEnv,
  alertsToText,
  startAlertmanagerReceiver,
} from './alertmanager.js';
import { SmsAlertSink } from './alerts.js';
import type { AlertSender } from './sms/sms-provider.js';

const TOKEN = 'a'.repeat(40);

class RecordingSender implements AlertSender {
  readonly sent: { mobile: string; code: string }[] = [];
  sendAlert(mobile: string, code: string): Promise<void> {
    this.sent.push({ mobile, code });
    return Promise.resolve();
  }
}

/** Alertmanager's webhook body (version 4), trimmed to what matters. */
const body = (...alerts: { status: string; alertname: string; severity?: string }[]) => ({
  version: '4',
  status: 'firing',
  receiver: 'on-call-sms',
  alerts: alerts.map((a) => ({
    status: a.status,
    labels: {
      alertname: a.alertname,
      instance: 'db-1:9187',
      ...(a.severity ? { severity: a.severity } : {}),
    },
    annotations: { summary: 'whatever the rule says' },
  })),
});

describe('which alerts are texted', () => {
  it('only firing and critical, each name once', () => {
    expect(
      alertsToText(
        body(
          { status: 'firing', alertname: 'ReplicaLagSevere', severity: 'critical' },
          { status: 'firing', alertname: 'ReplicaLagSevere', severity: 'critical' },
          { status: 'firing', alertname: 'DiskFilling', severity: 'warning' },
          { status: 'resolved', alertname: 'WalArchiveStale', severity: 'critical' },
          { status: 'firing', alertname: 'NoSeverity' },
        ),
      ),
    ).toEqual(['ReplicaLagSevere']);
  });

  it('refuses a name that is no Prometheus alert name', () => {
    expect(() =>
      alertsToText(body({ status: 'firing', alertname: 'x y; 09121234567', severity: 'critical' })),
    ).toThrow();
  });
});

describe('ALERTMANAGER_WEBHOOK_*', () => {
  it('off when neither is set; both, or a mistake', () => {
    expect(alertmanagerReceiverFromEnv({})).toBeNull();
    expect(() => alertmanagerReceiverFromEnv({ ALERTMANAGER_WEBHOOK_PORT: '9466' })).toThrow(
      'go together',
    );
    expect(() =>
      alertmanagerReceiverFromEnv({
        ALERTMANAGER_WEBHOOK_PORT: '9466',
        ALERTMANAGER_WEBHOOK_TOKEN: 'short',
      }),
    ).toThrow('at least 32');
    expect(() =>
      alertmanagerReceiverFromEnv({
        ALERTMANAGER_WEBHOOK_PORT: '99999',
        ALERTMANAGER_WEBHOOK_TOKEN: TOKEN,
      }),
    ).toThrow('port number');
  });

  it('binds to the loopback unless told otherwise', () => {
    expect(
      alertmanagerReceiverFromEnv({
        ALERTMANAGER_WEBHOOK_PORT: '9466',
        ALERTMANAGER_WEBHOOK_TOKEN: TOKEN,
      }),
    ).toEqual({ port: 9466, host: '127.0.0.1', token: TOKEN });
  });
});

describe('the receiver', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => {
        resolve();
      });
    });
    server = undefined;
  });

  async function start(sender: RecordingSender) {
    server = await startAlertmanagerReceiver({
      port: 0,
      host: '127.0.0.1',
      token: TOKEN,
      sink: new SmsAlertSink(sender, ['9121234567'], () => undefined),
      log: () => undefined,
    });
    const { port } = server.address() as AddressInfo;
    return (init: { path?: string; method?: string; token?: string; body?: string }) =>
      fetch(`http://127.0.0.1:${String(port)}${init.path ?? ALERTMANAGER_PATH}`, {
        method: init.method ?? 'POST',
        headers: {
          authorization: `Bearer ${init.token ?? TOKEN}`,
          'content-type': 'application/json',
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
  }

  it('texts a critical alert by name to the on-call number, once per cooldown', async () => {
    const sender = new RecordingSender();
    const send = await start(sender);
    const payload = JSON.stringify(
      body({ status: 'firing', alertname: 'WalArchiveStale', severity: 'critical' }),
    );
    expect((await send({ body: payload })).status).toBe(204);
    expect((await send({ body: payload })).status).toBe(204);
    expect(sender.sent).toEqual([{ mobile: '9121234567', code: 'WalArchiveStale' }]);
  });

  it('refuses without the token, elsewhere, other methods, bad or huge bodies', async () => {
    const sender = new RecordingSender();
    const send = await start(sender);
    const payload = JSON.stringify(
      body({ status: 'firing', alertname: 'HostDown', severity: 'critical' }),
    );
    expect((await send({ body: payload, token: 'b'.repeat(40) })).status).toBe(401);
    expect((await send({ body: payload, token: '' })).status).toBe(401);
    expect((await send({ body: payload, path: '/metrics' })).status).toBe(404);
    expect((await send({ method: 'GET' })).status).toBe(405);
    expect((await send({ body: '{not json' })).status).toBe(400);
    expect((await send({ body: JSON.stringify({ alerts: 'x' }) })).status).toBe(400);
    expect((await send({ body: 'x'.repeat(70 * 1024) })).status).toBe(413);
    expect(sender.sent).toEqual([]);
  });
});

describe('ops/monitoring/alertmanager.yml', () => {
  const config = readFileSync(
    new URL('../../../ops/monitoring/alertmanager.yml', import.meta.url),
    'utf8',
  );

  it('sends critical alerts to this receiver, with its token from a file, never resolved', () => {
    expect(config).toContain(`url: http://worker:9466${ALERTMANAGER_PATH}`);
    expect(config).toMatch(/matchers: \['severity="critical"'\]\s+receiver: on-call-sms/);
    expect(config).toContain('credentials_file: /etc/alertmanager/secrets/worker-webhook-token');
    expect(config).toContain('send_resolved: false');
    expect(config).toContain('max_alerts: 200');
  });
});
