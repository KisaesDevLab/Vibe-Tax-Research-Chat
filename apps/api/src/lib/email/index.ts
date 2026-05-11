// Barrel re-exports for the email module. Importers should pull from
// `lib/email` rather than the specific provider files.
export type {
  EmailConfig,
  EmailProviderKind,
  MailProvider,
  OutboundMessage,
  SmtpSettings,
} from './provider.js';
export { buildMailer, resetMailer, buildProviderFromDraft } from './provider.js';
export type { RenderedEmail, ResetEmailInputs, TestEmailInputs } from './templates.js';
export { renderResetEmail, renderTestEmail } from './templates.js';
