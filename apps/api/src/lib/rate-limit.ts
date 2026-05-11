// Phase 3 + 28 — Redis-backed rate limiters.
//   loginLimiter: 5 attempts / 15 min / IP — defends /api/auth/login.
//   setupBootstrapLimiter: 5 attempts / 15 min / IP — defends /api/setup/bootstrap
//     so a partially-restored DB (zero admins) cannot be brute-bootstrapped.
//   forgotPasswordLimiter: 5 attempts / 60 min / IP — defends the public
//     /api/auth/forgot-password endpoint from being used to spam users.
//   resetPasswordLimiter: 10 attempts / 60 min / IP — defends the public
//     /api/auth/reset-password endpoint from token brute-forcing (the token
//     itself is 256 bits so brute-force is intractable; the limiter is
//     belt-and-braces against scripted attempts).
import rateLimit from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { getRedis } from './redis.js';

const sendCommand = async (...args: string[]): Promise<RedisReply> => {
  const [cmd, ...rest] = args;
  if (!cmd) throw new Error('rate-limit-redis: empty command');
  const result = await getRedis().call(cmd, ...rest);
  return result as RedisReply;
};

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand, prefix: 'rl:login:' }),
  message: { error: 'too_many_login_attempts', retry_after_seconds: 900 },
});

export const setupBootstrapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand, prefix: 'rl:setup-bootstrap:' }),
  message: { error: 'too_many_bootstrap_attempts', retry_after_seconds: 900 },
});

export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand, prefix: 'rl:forgot-password:' }),
  message: { error: 'too_many_forgot_password_attempts', retry_after_seconds: 3600 },
});

export const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisStore({ sendCommand, prefix: 'rl:reset-password:' }),
  message: { error: 'too_many_reset_password_attempts', retry_after_seconds: 3600 },
});
