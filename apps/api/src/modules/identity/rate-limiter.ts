import type { Redis } from 'ioredis';

/**
 * Counters and temporary locks in Redis. All keys expire on their own; nothing here needs
 * cleaning up. Keys are prefixed `identity:` and hold no personal data beyond what the
 * key itself names (a normalized mobile, an IP, a device id).
 */

export interface HitResult {
  readonly allowed: boolean;
  readonly count: number;
  /** Seconds until the window resets. */
  readonly retryAfterSeconds: number;
}

export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  /** Counts one event in a fixed window; `allowed` is false once `limit` is exceeded. */
  async hit(key: string, limit: number, windowSeconds: number): Promise<HitResult> {
    const redisKey = `identity:${key}`;
    // Atomic: count the hit and start the window's expiry only if it has none yet (NX).
    const results = await this.redis
      .multi()
      .incr(redisKey)
      .expire(redisKey, windowSeconds, 'NX')
      .ttl(redisKey)
      .exec();
    if (!results) throw new Error('rate limiter transaction was aborted');
    const [[incrError, count], , [ttlError, ttl]] = results as [
      [Error | null, number],
      unknown,
      [Error | null, number],
    ];
    const error = incrError ?? ttlError;
    if (error) throw error;
    return { allowed: count <= limit, count, retryAfterSeconds: Math.max(ttl, 1) };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(`identity:${key}`);
  }

  async lock(key: string, seconds: number): Promise<void> {
    await this.redis.set(`identity:lock:${key}`, '1', 'EX', seconds);
  }

  /** Seconds left on a lock, or 0 if not locked. */
  async lockedFor(key: string): Promise<number> {
    const ttl = await this.redis.ttl(`identity:lock:${key}`);
    return ttl > 0 ? ttl : 0;
  }

  /**
   * Records a failure; after `threshold` failures within the window the key is locked for
   * `lockSeconds` and the counter starts over. Returns the lock time, or 0.
   */
  async recordFailure(
    key: string,
    threshold: number,
    windowSeconds: number,
    lockSeconds: number,
  ): Promise<number> {
    const { count } = await this.hit(`fail:${key}`, threshold, windowSeconds);
    if (count < threshold) return 0;
    await this.lock(key, lockSeconds);
    await this.reset(`fail:${key}`);
    return lockSeconds;
  }

  async clearFailures(key: string): Promise<void> {
    await this.reset(`fail:${key}`);
  }
}
