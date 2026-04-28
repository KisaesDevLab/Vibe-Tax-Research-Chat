// Phase 5 + 12 — Anthropic client constructed per-request with the decrypted key.
//
// Key flow:
//   1. Pull encrypted setting from settings table.
//   2. Decrypt in-memory via lib/crypto.open.
//   3. Construct Anthropic({ apiKey }) and use it for one request.
//   4. Drop the reference. The key is never logged, never persisted as plaintext.

import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../settings-store.js';
import { SETTING_KEYS } from '@vibe/db/schema';
import { fingerprint } from '../crypto.js';

export interface AnthropicHandle {
  client: Anthropic;
  key_fingerprint: string;
}

export async function getAnthropic(): Promise<AnthropicHandle> {
  const key = await getSetting<string>(SETTING_KEYS.ANTHROPIC_API_KEY);
  if (!key) {
    throw new Error('Anthropic API key is not configured. Admin must set it via Admin → Settings.');
  }
  const client = new Anthropic({ apiKey: key });
  return { client, key_fingerprint: fingerprint(key) };
}

// 1-token validation call used at key save time.
export async function validateKey(rawKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Anthropic({ apiKey: rawKey });
    await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
