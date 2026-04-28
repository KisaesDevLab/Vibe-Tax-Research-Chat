// Phase 5 — crypto round-trip + tampering detection.
import { describe, expect, it, beforeAll } from 'vitest';
import crypto from 'node:crypto';

beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6379';
});

describe('crypto', () => {
  it('round-trips a plaintext via seal/open', async () => {
    const { seal, open } = await import('./crypto.js');
    const sealed = seal('sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'anthropic_api_key');
    const out = open(sealed, 'anthropic_api_key');
    expect(out).toBe('sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXXXXXX');
  });

  it('rejects a tampered ciphertext', async () => {
    const { seal, open } = await import('./crypto.js');
    const sealed = seal('hello', 'test');
    sealed.ciphertext = Buffer.from('00000000', 'hex').toString('base64');
    expect(() => open(sealed, 'test')).toThrow();
  });

  it('rejects a wrong purpose', async () => {
    const { seal, open } = await import('./crypto.js');
    const sealed = seal('hello', 'purpose-a');
    expect(() => open(sealed, 'purpose-b')).toThrow(/purpose mismatch/);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV/salt)', async () => {
    const { seal } = await import('./crypto.js');
    const a = seal('same', 'p');
    const b = seal('same', 'p');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fingerprint shows only first 8 + last 4 chars', async () => {
    const { fingerprint } = await import('./crypto.js');
    const key = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234';
    expect(fingerprint(key)).toBe('sk-ant-a…1234');
  });
});
