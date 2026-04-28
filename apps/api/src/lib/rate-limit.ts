// Phase 3 — login brute-force limiter. Redis sliding window: 5 attempts / 15 min / IP.
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { getRedis } from './redis.js';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: (...args: string[]) => getRedis().call(args[0], ...args.slice(1)) as Promise<unknown>,
    prefix: 'rl:login:',
  }),
  message: { error: 'too_many_login_attempts', retry_after_seconds: 900 },
});
