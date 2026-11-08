import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { requiredEnv } from './env';

/** Injection token of the shared ioredis client (REDIS_URL). */
export const REDIS = Symbol('REDIS');

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end' && this.redis.status !== 'wait') await this.redis.quit();
  }
}

/** Redis for counters, locks and short-lived challenges. Connects on first command. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (): Redis =>
        new Redis(requiredEnv('REDIS_URL'), { lazyConnect: true, maxRetriesPerRequest: 3 }),
    },
    RedisShutdown,
  ],
  exports: [REDIS],
})
export class RedisModule {}
