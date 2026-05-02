// Pino logger for authority-mcp. Mirrors the api package's redaction
// posture even though the service handles no PII directly — defense in
// depth in case a future tool accepts user-supplied query text.
import pino from 'pino';
import { env } from './config.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  // Redact anything that looks like a secret if a future request body
  // bubbles through structured logging.
  redact: {
    paths: ['req.headers.authorization', '*.password', '*.api_key', '*.secret'],
    censor: '[REDACTED]',
  },
});
