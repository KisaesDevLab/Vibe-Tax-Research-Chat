import { describe, it, expect } from 'vitest';
import { canonicalStringify, sha256Canonical } from './canonical-json.js';

describe('canonicalStringify', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives, null, and unicode strings', () => {
    expect(canonicalStringify('naïve — “quotes”')).toBe(JSON.stringify('naïve — “quotes”'));
    expect(canonicalStringify(null)).toBe('null');
    expect(canonicalStringify(42.5)).toBe('42.5');
    expect(canonicalStringify(true)).toBe('true');
  });

  it('drops undefined object values and nullifies undefined array slots', () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalStringify([undefined, 1])).toBe('[null,1]');
  });

  it('produces identical hashes regardless of insertion order (jsonb round-trip)', () => {
    const original = { chat: { title: 't', id: 'x' }, messages: [{ role: 'user', content: 'hi' }] };
    // Simulate jsonb normalization: parse of a re-ordered serialization.
    const roundTripped = JSON.parse(
      '{"messages":[{"content":"hi","role":"user"}],"chat":{"id":"x","title":"t"}}',
    ) as unknown;
    expect(sha256Canonical(original)).toBe(sha256Canonical(roundTripped));
  });

  it('changes the hash when content changes', () => {
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
  });
});
