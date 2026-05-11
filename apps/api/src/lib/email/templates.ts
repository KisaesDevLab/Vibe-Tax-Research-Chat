// Outbound message templates. Each render function returns a fully-
// rendered { subject, text, html } so providers don't have to know which
// template was used. Kept provider-agnostic so the same payload works
// for SMTP and Resend.

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface ResetEmailInputs {
  user_email: string;
  reset_url: string;
  expires_minutes: number;
  app_name?: string;
}

export function renderResetEmail(i: ResetEmailInputs): RenderedEmail {
  const app = i.app_name ?? 'Vibe Tax Research';
  const subject = `${app} — password reset`;
  const text = [
    `Hi,`,
    ``,
    `Someone requested a password reset for ${i.user_email}. Click the link below to`,
    `choose a new password. This link expires in ${i.expires_minutes} minutes and can`,
    `only be used once.`,
    ``,
    i.reset_url,
    ``,
    `If you didn't request this, you can safely ignore this email — your password`,
    `will not be changed.`,
    ``,
    `— ${app}`,
  ].join('\n');
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1714; background: #f7f3ec; padding: 32px;">
  <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid rgba(26,23,20,0.1); border-radius: 6px; padding: 32px;">
    <h1 style="font-size: 20px; margin: 0 0 12px;">Password reset</h1>
    <p style="line-height: 1.5;">Someone requested a password reset for <strong>${escapeHtml(i.user_email)}</strong>.</p>
    <p style="line-height: 1.5;">Click the button below to choose a new password. This link expires in ${i.expires_minutes} minutes and can only be used once.</p>
    <p style="margin: 24px 0;">
      <a href="${escapeAttr(i.reset_url)}" style="display: inline-block; background: #1a1714; color: #f7f3ec; text-decoration: none; padding: 10px 20px; border-radius: 4px; font-weight: 500;">Reset password</a>
    </p>
    <p style="font-size: 13px; color: rgba(26,23,20,0.6); line-height: 1.5;">If the button doesn't work, paste this URL into your browser:</p>
    <p style="font-family: 'JetBrains Mono', monospace; font-size: 12px; word-break: break-all;">${escapeHtml(i.reset_url)}</p>
    <hr style="border: none; border-top: 1px solid rgba(26,23,20,0.1); margin: 24px 0;" />
    <p style="font-size: 13px; color: rgba(26,23,20,0.6); line-height: 1.5;">If you didn't request this, you can safely ignore this email — your password will not be changed.</p>
    <p style="font-size: 13px; color: rgba(26,23,20,0.6);">— ${app}</p>
  </div>
</body></html>`;
  return { subject, text, html };
}

export interface TestEmailInputs {
  app_name?: string;
}

export function renderTestEmail(i: TestEmailInputs = {}): RenderedEmail {
  const app = i.app_name ?? 'Vibe Tax Research';
  return {
    subject: `${app} — test email`,
    text: `This is a test message from ${app}. If you received this, your email settings are working.`,
    html: `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 24px;">
  <p>This is a test message from <strong>${escapeHtml(app)}</strong>.</p>
  <p>If you received this, your email settings are working.</p>
</body></html>`,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
