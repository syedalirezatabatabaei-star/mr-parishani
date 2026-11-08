import { connect } from 'node:net';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres } from './support/postgres';

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

describe('Postgres test container', () => {
  let postgres: StartedPostgreSqlContainer;

  beforeAll(async () => {
    postgres = await startPostgres();
  });

  afterAll(async () => {
    await postgres.stop();
  });

  it('runs Postgres 17 and answers queries', async () => {
    const result = await postgres.exec([
      'psql',
      '-U',
      postgres.getUsername(),
      '-d',
      postgres.getDatabase(),
      '-tAc',
      'SHOW server_version_num',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toMatch(/^17\d{4}$/);
  });

  it('is reachable from the host on the port the container reports', async () => {
    const uri = new URL(postgres.getConnectionUri());
    expect(Number(uri.port)).toBe(postgres.getPort());
    await expect(canConnect(postgres.getHost(), postgres.getPort())).resolves.toBe(true);
  });
});
