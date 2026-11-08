import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { z } from 'zod';

/**
 * Alertmanager's webhook into the on-call SMS (task 10-3, ops/monitoring/README.md): the
 * Prometheus rules' critical alerts reach the same numbers, through the same Kavenegar
 * template, as the worker's own alerts. No notifier outside Iran (doc 19 §10-3).
 *
 * Only `firing` alerts of severity `critical` are texted, and only their name (the rule's
 * `alertname`): labels carry host names and nothing personal, but an SMS needs none of it.
 * Warnings and `resolved` notices stay in Grafana. Every request needs the bearer token;
 * the port is for the internal network only and binds to 127.0.0.1 unless told otherwise.
 */

/** Where texted alerts go: the worker's SmsAlertSink (its own cooldown per name). */
export interface ReceivedAlertSink {
  raise(alert: { readonly code: string; readonly message: string }): Promise<void>;
}

export interface AlertmanagerReceiverOptions {
  readonly port: number;
  readonly host: string;
  readonly token: string;
  readonly sink: ReceivedAlertSink;
  readonly log?: (line: string) => void;
}

export const ALERTMANAGER_PATH = '/alertmanager';
const MAX_BODY_BYTES = 64 * 1024;
const MIN_TOKEN_LENGTH = 32;

/** An alert name as Prometheus allows it, short enough for one SMS token. */
const alertName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/);

/** Alertmanager's webhook body (version 4); only what is used, the rest ignored. */
const webhookSchema = z.object({
  alerts: z
    .array(
      z.object({
        status: z.enum(['firing', 'resolved']),
        labels: z.looseObject({ alertname: alertName, severity: z.string().optional() }),
      }),
    )
    .max(200),
});

/** The alert names to text from one webhook body, once each. */
export function alertsToText(body: unknown): string[] {
  const parsed = webhookSchema.parse(body);
  const names = parsed.alerts
    .filter((a) => a.status === 'firing' && a.labels.severity === 'critical')
    .map((a) => a.labels.alertname);
  return [...new Set(names)];
}

const digest = (value: string) => createHash('sha256').update(value).digest();

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  return timingSafeEqual(digest(given), digest(token));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * ALERTMANAGER_WEBHOOK_PORT and ALERTMANAGER_WEBHOOK_TOKEN (at least 32 characters) turn
 * the receiver on; neither means off. One without the other is a mistake, not a default.
 * ALERTMANAGER_WEBHOOK_HOST: 127.0.0.1 unless set (0.0.0.0 inside a container network).
 */
export function alertmanagerReceiverFromEnv(
  env: NodeJS.ProcessEnv,
): Omit<AlertmanagerReceiverOptions, 'sink' | 'log'> | null {
  const port = env['ALERTMANAGER_WEBHOOK_PORT']?.trim() ?? '';
  const token = env['ALERTMANAGER_WEBHOOK_TOKEN'] ?? '';
  if (port === '' && token === '') return null;
  if (port === '' || token === '') {
    throw new Error('ALERTMANAGER_WEBHOOK_PORT and ALERTMANAGER_WEBHOOK_TOKEN go together');
  }
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error('ALERTMANAGER_WEBHOOK_PORT must be a port number');
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `ALERTMANAGER_WEBHOOK_TOKEN must be at least ${String(MIN_TOKEN_LENGTH)} characters`,
    );
  }
  return {
    port: Number(port),
    host: env['ALERTMANAGER_WEBHOOK_HOST']?.trim() || '127.0.0.1',
    token,
  };
}

/** Starts listening; resolves once the port is bound. */
export async function startAlertmanagerReceiver(
  options: AlertmanagerReceiverOptions,
): Promise<Server> {
  const log = options.log ?? console.error;
  /** What one request texts; a status when it is refused. */
  const handle = async (req: IncomingMessage): Promise<number> => {
    if (req.url !== ALERTMANAGER_PATH) return 404;
    if (req.method !== 'POST') return 405;
    if (!authorized(req, options.token)) return 401;
    const text = await readBody(req);
    if (text === null) return 413;
    let names: string[];
    try {
      names = alertsToText(JSON.parse(text));
    } catch {
      return 400;
    }
    for (const name of names) {
      await options.sink.raise({ code: name, message: `prometheus alert ${name}` });
    }
    return 204;
  };
  const server = createServer((req, res) => {
    const reply = (status: number) => {
      res.writeHead(status).end();
    };
    void handle(req)
      .then(reply)
      .catch((error: unknown) => {
        log(`[alertmanager] ${error instanceof Error ? error.message : 'unknown error'}`);
        if (!res.headersSent) reply(500);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
