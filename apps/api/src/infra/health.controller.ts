import { Controller, Get, HttpException, HttpStatus, Inject, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { Public } from '../common/auth/auth.decorators';
import { ZodResponse } from '../common/zod-response';
import { DATABASE, type Database } from '../db/database.module';
import { REDIS } from './redis.module';

/**
 * Probes for the orchestrator and the load balancer (task 0-7). Public and without
 * detail beyond up/down: they are reachable before any login.
 */
const liveSchema = z.object({ status: z.literal('ok') });
/** Only the 200 answer; a 503 carries `status: 'unavailable'` and which check is down. */
const readySchema = z.object({
  status: z.literal('ok'),
  checks: z.object({ database: z.literal('ok'), redis: z.literal('ok') }),
});

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The process answers. */
  @Public()
  @Get('live')
  @ZodResponse(liveSchema)
  live() {
    return { status: 'ok' };
  }

  /** Postgres and Redis answer too; 503 otherwise, so traffic goes elsewhere. */
  @Public()
  @Get('ready')
  @ZodResponse(readySchema)
  async ready() {
    const timeout = <T>(p: Promise<T>) =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error('timeout'));
          }, 2_000).unref(),
        ),
      ]);
    const [db, redis] = await Promise.allSettled([
      timeout(this.db.execute(sql`SELECT 1`)),
      timeout(this.redis.ping()),
    ]);
    const checks = {
      database: db.status === 'fulfilled' ? 'ok' : 'down',
      redis: redis.status === 'fulfilled' ? 'ok' : 'down',
    };
    if (checks.database !== 'ok' || checks.redis !== 'ok') {
      throw new HttpException({ status: 'unavailable', checks }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok', checks };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
