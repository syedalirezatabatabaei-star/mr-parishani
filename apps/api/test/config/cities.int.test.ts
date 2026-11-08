import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool';
import { call, startHarness, type Harness } from '../identity/harness';

/**
 * The cities (task 2-11, migration 0020; ADR-010): public names for pages, one flag for
 * where the network works; the application only reads the table, and nothing deletes it.
 */
let h: Harness;
let app: Pool;

beforeAll(async () => {
  h = await startHarness();
  app = createPool(h.db.appUrl, 'test-app');
}, 300_000);

afterAll(async () => {
  await app.end();
  await h.close();
});

describe('cities', () => {
  it('are listed for anyone, in order; Isfahan, Kashan and Shahin Shahr are the active ones', async () => {
    const res = await call(h, 'GET', '/config/cities');
    expect(res.status).toBe(200);
    const list = res.body as unknown as { code: string; name: string; active: boolean }[];
    expect(list[0]).toEqual({ code: 'isfahan', name: 'اصفهان', active: true });
    // Known but not active: the network does not work there yet.
    expect(list.find((c) => c.code === 'tehran')).toEqual({
      code: 'tehran',
      name: 'تهران',
      active: false,
    });
    expect(list.map((c) => c.code)).toContain('shiraz');
    expect(list.filter((c) => c.active).map((c) => c.code)).toEqual([
      'isfahan',
      'kashan',
      'shahin_shahr',
    ]);
    expect(list).toHaveLength(12);
  });

  it('the application cannot add or change one, and no one can delete one', async () => {
    await expect(
      app.query(`INSERT INTO cities (code, name) VALUES ('yazd', 'یزد')`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query(`UPDATE cities SET active = true WHERE code = 'shiraz'`),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(h.owner.query(`DELETE FROM cities WHERE code = 'rasht'`)).rejects.toThrow();
  });

  it('a code must be in the form every stored city code has', async () => {
    await expect(
      h.owner.query(`INSERT INTO cities (code, name) VALUES ('Yazd City', 'یزد')`),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
