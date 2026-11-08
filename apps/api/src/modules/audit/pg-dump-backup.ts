import { spawn } from 'node:child_process';
import { createWriteStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { requiredEnv } from '../../infra/env';
import type { BackupTaker } from './field-reencryption.service';

/**
 * The backup a re-encryption run takes first (R4; owner: a pg_dump before running): `pg_dump -Fc`
 * of REENCRYPT_BACKUP_DATABASE_URL into REENCRYPT_BACKUP_DIR, encrypted on the way with `age`
 * for BACKUP_AGE_RECIPIENT (required in production, so no plain dump lands on the server;
 * runbook §3). PG_DUMP_COMMAND, a JSON array, runs pg_dump some other way (a container).
 * Any failure, or an empty file, stops the run before a row is written.
 */
export class PgDumpBackup implements BackupTaker {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async take(): Promise<string> {
    const url = requiredEnv('REENCRYPT_BACKUP_DATABASE_URL', this.env);
    const dir = requiredEnv('REENCRYPT_BACKUP_DIR', this.env);
    const recipient = (this.env['BACKUP_AGE_RECIPIENT'] ?? '').trim();
    if (recipient === '' && this.env['NODE_ENV'] === 'production') {
      throw new Error('BACKUP_AGE_RECIPIENT is required in production: no plain dump on a server');
    }
    const command = this.command();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(dir, `sepehr-before-reencrypt-${stamp}.dump${recipient ? '.age' : ''}`);

    const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    const dump = spawn(command[0] as string, [...command.slice(1), '-Fc', '--dbname', url], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const age = recipient
      ? spawn('age', ['-r', recipient], { stdio: ['pipe', 'pipe', 'inherit'] })
      : null;
    if (age) {
      dump.stdout.pipe(age.stdin);
      age.stdout.pipe(out);
    } else {
      dump.stdout.pipe(out);
    }
    const exit = (child: ReturnType<typeof spawn>, name: string) =>
      new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${name} exited with ${String(code)}`));
        });
      });
    const written = new Promise<void>((resolve, reject) => {
      out.once('finish', resolve);
      out.once('error', reject);
    });
    await Promise.all([exit(dump, 'pg_dump'), ...(age ? [exit(age, 'age')] : []), written]);
    if (statSync(file).size === 0) throw new Error('the backup is empty');
    return file;
  }

  private command(): string[] {
    const raw = this.env['PG_DUMP_COMMAND'];
    if (!raw) return ['pg_dump'];
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((p): p is string => typeof p === 'string')
    ) {
      throw new Error('PG_DUMP_COMMAND must be a JSON array of strings');
    }
    return parsed;
  }
}
