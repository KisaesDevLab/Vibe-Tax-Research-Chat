// lib/vibeAuthSecret — the OIDC client secret's at-rest wrapping, shared by
// the engine's secretWrap and the DR restore's re-key.
import { describe, it, expect } from 'vitest';
import {
  unwrapClientSecretWith,
  wrapClientSecretWith,
  VIBE_AUTH_SECRET_PURPOSE,
} from './vibeAuthSecret.js';

const KEY_A = '11'.repeat(32);
const KEY_B = '22'.repeat(32);

describe('client secret wrap', () => {
  it('round-trips under the same key and is a JSON SealedValue with the fixed purpose', () => {
    const wrapped = wrapClientSecretWith(KEY_A, 's3cret');
    expect(JSON.parse(wrapped)).toMatchObject({ purpose: VIBE_AUTH_SECRET_PURPOSE });
    expect(wrapped).not.toContain('s3cret');
    expect(unwrapClientSecretWith(KEY_A, wrapped)).toBe('s3cret');
  });

  it('refuses another key and a tampered purpose (what the restore re-key relies on)', () => {
    const wrapped = wrapClientSecretWith(KEY_A, 's3cret');
    expect(() => unwrapClientSecretWith(KEY_B, wrapped)).toThrow();
    const tampered = JSON.stringify({ ...JSON.parse(wrapped), purpose: 'settings.anthropic_key' });
    expect(() => unwrapClientSecretWith(KEY_A, tampered)).toThrow(/purpose mismatch/);
    // Re-key: unwrap under A, wrap under B, unwrap under B.
    expect(
      unwrapClientSecretWith(
        KEY_B,
        wrapClientSecretWith(KEY_B, unwrapClientSecretWith(KEY_A, wrapped)),
      ),
    ).toBe('s3cret');
  });
});
