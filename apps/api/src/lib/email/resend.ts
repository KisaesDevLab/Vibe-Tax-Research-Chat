// Resend SDK provider. verify() probes the /domains endpoint to detect
// an invalid API key without sending a real message — the dedicated
// "Send test email" button in the admin UI is the actual end-to-end check.

import { Resend } from 'resend';
import type { EmailConfig, MailProvider, OutboundMessage } from './provider.js';

export function createResendProvider(config: EmailConfig, apiKey: string): MailProvider {
  const client = new Resend(apiKey);
  const from = config.from_name
    ? `${config.from_name} <${config.from_address}>`
    : config.from_address;

  return {
    kind: 'resend',
    async verify() {
      // 401/403 → bad key. 5xx → Resend outage; surface as a failure so the
      // admin retries. Anything else (including a 404 if /domains shape
      // changes) is treated as "key looks plausible" — the test-email
      // button is the definitive validation.
      const res = await fetch('https://api.resend.com/domains', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Resend rejected the API key (HTTP ${res.status})`);
      }
      if (res.status >= 500) {
        throw new Error(`Resend API unavailable (HTTP ${res.status})`);
      }
    },
    async send(msg: OutboundMessage) {
      const result = await client.emails.send({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
      if (result.error) {
        throw new Error(`Resend send failed: ${result.error.message}`);
      }
    },
  };
}
