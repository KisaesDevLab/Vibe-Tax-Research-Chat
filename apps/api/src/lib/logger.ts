// Phase 1 — Pino logger with redaction. Never log secrets.
import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.password_hash',
      '*.refresh_token',
      '*.token_hash',
      '*.MASTER_KEY',
      '*.JWT_SECRET',
      '*.JWT_REFRESH_SECRET',
      '*.ANTHROPIC_API_KEY',
      '*.anthropic_api_key',
      '*.ciphertext',
    ],
    censor: '[REDACTED]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
      : undefined,
});
