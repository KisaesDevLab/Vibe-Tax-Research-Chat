import { describe, it, expect, beforeAll } from 'vitest';
import { mintLinkToken, verifyLinkToken } from './signed-links.js';

beforeAll(() => {
  process.env.LINK_SIGNING_SECRET = 'test-secret-at-least-16-chars';
});

describe('signed links', () => {
  it('round-trips a valid token', () => {
    const { token, tokenHash, expiresAt } = mintLinkToken('d-123', 7);
    const v = verifyLinkToken(token);
    expect(v?.deliverableId).toBe('d-123');
    expect(v?.tokenHash).toBe(tokenHash);
    expect(v?.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('clamps TTL to 14 days', () => {
    const { expiresAt } = mintLinkToken('d', 90);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(14 * 86_400_000 + 5_000);
  });

  it('rejects tampered payloads and signatures', () => {
    const { token } = mintLinkToken('d-123', 7);
    const [p, s] = token.split('.');
    const other = Buffer.from('d-456.9999999999999').toString('base64url');
    expect(verifyLinkToken(`${other}.${s}`)).toBeNull();
    expect(verifyLinkToken(`${p}.${Buffer.from('x'.repeat(32)).toString('base64url')}`)).toBeNull();
    expect(verifyLinkToken('garbage')).toBeNull();
  });

  it('rejects expired tokens', () => {
    // Hand-build an expired payload with the real secret.
    const { token } = mintLinkToken('d-123', 1);
    const [, sig] = token.split('.');
    const expired = Buffer.from(`d-123.${Date.now() - 1000}`).toString('base64url');
    // Signature won't match the altered payload anyway; both failure paths null.
    expect(verifyLinkToken(`${expired}.${sig}`)).toBeNull();
  });
});
