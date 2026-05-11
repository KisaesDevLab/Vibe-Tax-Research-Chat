import { describe, expect, it } from 'vitest';
import { renderResetEmail, renderTestEmail } from './templates.js';

describe('renderResetEmail', () => {
  it('includes the reset URL in both text and html parts', () => {
    const out = renderResetEmail({
      user_email: 'user@firm.example',
      reset_url: 'https://appliance.example/reset?token=abc123',
      expires_minutes: 60,
    });
    expect(out.text).toContain('https://appliance.example/reset?token=abc123');
    expect(out.html).toContain('https://appliance.example/reset?token=abc123');
  });

  it('renders the configured app name in the subject', () => {
    const out = renderResetEmail({
      user_email: 'a@b.c',
      reset_url: 'http://x',
      expires_minutes: 30,
      app_name: 'Firm XYZ Research',
    });
    expect(out.subject).toBe('Firm XYZ Research — password reset');
  });

  it('escapes HTML in the recipient email so a crafted address cannot inject markup', () => {
    const out = renderResetEmail({
      user_email: '<script>alert(1)</script>@x.test',
      reset_url: 'http://x',
      expires_minutes: 30,
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('escapes HTML in the reset URL when rendered as plaintext text-pasting fallback', () => {
    // The href attribute is also escaped; the plaintext-display variant
    // (`paste this URL into your browser`) is the riskier one.
    const out = renderResetEmail({
      user_email: 'a@b.c',
      reset_url: 'http://x/r?token=a"b<c',
      expires_minutes: 30,
    });
    // The visible URL text must not contain raw < > " chars.
    expect(out.html).not.toMatch(/>\s*http:\/\/x\/r\?token=a"b<c\s*</);
  });

  it('reflects the expiry minutes in the body text', () => {
    const out = renderResetEmail({
      user_email: 'a@b.c',
      reset_url: 'http://x',
      expires_minutes: 45,
    });
    expect(out.text).toContain('45 minutes');
    expect(out.html).toContain('45 minutes');
  });
});

describe('renderTestEmail', () => {
  it('produces a stable subject + body', () => {
    const out = renderTestEmail();
    expect(out.subject).toContain('test email');
    expect(out.text).toMatch(/test message/i);
    expect(out.html).toMatch(/test message/i);
  });

  it('uses the supplied app name', () => {
    const out = renderTestEmail({ app_name: 'Acme CPA Research' });
    expect(out.subject).toContain('Acme CPA Research');
    expect(out.text).toContain('Acme CPA Research');
  });
});
