// nodemailer-based SMTP provider. verify() does a real handshake against
// the configured host so misconfigured settings fail the admin Save action
// rather than the first user reset.

import nodemailer from 'nodemailer';
import type { EmailConfig, MailProvider, OutboundMessage } from './provider.js';

export function createSmtpProvider(config: EmailConfig, password: string): MailProvider {
  if (!config.smtp) throw new Error('createSmtpProvider: config.smtp missing');
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: password },
  });
  const from = config.from_name
    ? `${config.from_name} <${config.from_address}>`
    : config.from_address;

  return {
    kind: 'smtp',
    async verify() {
      await transporter.verify();
    },
    async send(msg: OutboundMessage) {
      await transporter.sendMail({
        from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      });
    },
  };
}
