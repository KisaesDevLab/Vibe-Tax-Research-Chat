// Phase 3 — login brute-force limiter. Redis sliding window: 5 attempts / 15 min / IP.
import rateLimit from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getRedis } from './redis.js';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({
    sendCommand: async (...args: string[]): Promise<RedisReply> => {
      const [cmd, ...rest] = args;
      if (!cmd) throw new Error('rate-limit-redis: empty command');
      // ioredis `call` accepts (command, ...args) and returns whatever the
      // command returns — RedisReply (string|number|Buffer|null|array).
      const result = await getRedis().call(cmd, ...rest);
      return result as RedisReply;
    },
    prefix: 'rl:login:',
  }),
  message: { error: 'too_many_login_attempts', retry_after_seconds: 900 },
});
