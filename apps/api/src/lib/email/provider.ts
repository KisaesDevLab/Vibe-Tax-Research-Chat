// Provider-agnostic mailer factory. Reads EMAIL_CONFIG + the matching
// encrypted secret from the settings store and returns a MailProvider
// impl. The factory is a lazy singleton — built on first call, cached
// until resetMailer() is invoked (which the admin settings endpoint does
// after a successful save).

import { getSetting } from '../settings-store.js';
import { SETTING_KEYS } from '@vibe/db/schema';
import { logger } from '../logger.js';
import { createSmtpProvider } from './smtp.js';
import { createResendProvider } from './resend.js';

export type EmailProviderKind = 'smtp' | 'resend';

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
}

export interface EmailConfig {
  provider: EmailProviderKind;
  from_address: string;
  from_name: string;
  smtp?: SmtpSettings;
}

export interface OutboundMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailProvider {
  kind: EmailProviderKind;
  // Throws on configuration failure (bad SMTP creds, bad API key, etc).
  verify(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
}

// `undefined` = not yet attempted; `null` = no config / config invalid.
// Keeping the two states distinct lets callers tell "we haven't checked"
// from "we checked and there's nothing to send through".
let cached: MailProvider | null | undefined = undefined;

export function resetMailer(): void {
  cached = undefined;
}

export async function buildMailer(): Promise<MailProvider | null> {
  if (cached !== undefined) return cached;
  const config = await getSetting<EmailConfig>(SETTING_KEYS.EMAIL_CONFIG);
  if (!config) {
    cached = null;
    return null;
  }
  try {
    if (config.provider === 'smtp') {
      const password = await getSetting<string>(SETTING_KEYS.EMAIL_SMTP_PASSWORD);
      if (!config.smtp || !password) {
        cached = null;
        return null;
      }
      cached = createSmtpProvider(config, password);
    } else if (config.provider === 'resend') {
      const apiKey = await getSetting<string>(SETTING_KEYS.EMAIL_RESEND_API_KEY);
      if (!apiKey) {
        cached = null;
        return null;
      }
      cached = createResendProvider(config, apiKey);
    } else {
      cached = null;
    }
  } catch (err) {
    logger.error({ err }, 'buildMailer failed');
    cached = null;
  }
  return cached;
}

// Build a one-off provider from caller-supplied config + secret without
// going through the settings store. Used by the admin save endpoint to
// run verify() on the *draft* config before persisting it — otherwise
// the admin would have to save bad settings to find out they're bad.
export function buildProviderFromDraft(config: EmailConfig, secret: string): MailProvider {
  if (config.provider === 'smtp') {
    if (!config.smtp) throw new Error('smtp config missing');
    return createSmtpProvider(config, secret);
  }
  return createResendProvider(config, secret);
}
