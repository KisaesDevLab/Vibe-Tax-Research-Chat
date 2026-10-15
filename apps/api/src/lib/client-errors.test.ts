import { describe, expect, it } from 'vitest';
import { clientErrorSchema, fingerprintOf } from './client-errors.js';

const base = {
  kind: 'panel',
  source: 'Compliance',
  message: 'x.filter is not a function',
  stack:
    'TypeError: x.filter is not a function\n    at R2 (index-abc.js:1:2)\n    at _u (index-abc.js:3:4)',
  route: '/research/a1279f91-b049-4e88-9350-105d56ca4962',
  chat_id: 'a1279f91-b049-4e88-9350-105d56ca4962',
  message_id: '0b6e2c1e-8f43-4d55-9d0a-6b1b5f6a8a11',
};

describe('clientErrorSchema', () => {
  it('caps untrusted lengths and drops malformed ids instead of rejecting', () => {
    const r = clientErrorSchema.parse({
      ...base,
      message: 'm'.repeat(5000),
      stack: 's'.repeat(20000),
      chat_id: 'not-a-uuid',
      message_id: undefined,
    });
    expect(r.message).toHaveLength(1000);
    expect(r.stack).toHaveLength(8000);
    expect(r.chat_id).toBeNull();
    expect(r.message_id).toBeNull();
  });

  it('rejects unknown kinds and empty messages', () => {
    expect(clientErrorSchema.safeParse({ ...base, kind: 'other' }).success).toBe(false);
    expect(clientErrorSchema.safeParse({ ...base, message: '' }).success).toBe(false);
  });
});

describe('fingerprintOf', () => {
  const r = clientErrorSchema.parse(base);

  it('is stable for a repeat of the same failure', () => {
    // Deeper frames differ between React re-renders; only the top frame counts.
    const again = clientErrorSchema.parse({ ...base, stack: base.stack + '\n    at other' });
    expect(fingerprintOf(again, 'v1')).toBe(fingerprintOf(r, 'v1'));
  });

  it('separates messages, builds and panels', () => {
    const fp = fingerprintOf(r, 'v1');
    const otherMsg = clientErrorSchema.parse({
      ...base,
      message_id: 'f1e2d3c4-b5a6-4978-8877-665544332211',
    });
    expect(fingerprintOf(otherMsg, 'v1')).not.toBe(fp);
    expect(fingerprintOf(r, 'v2')).not.toBe(fp);
    expect(fingerprintOf({ ...r, source: 'Authorities' }, 'v1')).not.toBe(fp);
  });
});
