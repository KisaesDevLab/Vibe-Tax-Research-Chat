import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './chat.js';
import { WEB_ALLOWLIST, WEB_ALLOWLIST_JURISDICTIONS } from '@vibe/shared';

// These two rules are the whole reason the 50-state allowlist expansion is safe.
// Without them the model cannot tell an out-of-scope source from a broken tool,
// and a zero-result search degrades into a memory answer whose self-flagged
// citations are indistinguishable from verified ones.
describe('buildSystemPrompt — web grounding', () => {
  const prompt = buildSystemPrompt({ firm_name: 'Acme CPA' });

  it('tells the model exactly which sources it can reach', () => {
    for (const entry of WEB_ALLOWLIST.filter((e) => e.scope === 'federal')) {
      expect(prompt).toContain(entry.domain);
    }
    expect(prompt).toContain(String(WEB_ALLOWLIST_JURISDICTIONS.length));
  });

  it('names the categories that are never reachable', () => {
    // Distinguishing "out of scope" from "absent" is what stops the model
    // reporting a tool malfunction it cannot actually observe.
    for (const absent of ['CCH', 'Checkpoint', 'Westlaw', 'municipal', 'non-U.S.']) {
      expect(prompt).toContain(absent);
    }
  });

  it('forbids claiming a tool is rate-limited or unavailable', () => {
    expect(prompt).toMatch(/Never tell the user a tool is rate-limited/i);
  });

  it('forbids answering from memory with citations flagged for verification', () => {
    expect(prompt).toMatch(/Do NOT fall back to reciting statutes/i);
    expect(prompt).toMatch(/An unverified citation is not a citation/i);
  });

  it('tells the model to report an exhausted budget rather than close the gap', () => {
    // \s+ because the prompt is hard-wrapped — the phrase spans a line break.
    expect(prompt).toMatch(/do not close the\s+gap from memory/i);
  });

  it('still carries the pre-existing citation and sidecar contract', () => {
    // Guard against a future edit dropping these while rewriting the section.
    expect(prompt).toContain('[CITATION NEEDED — search: <query>]');
    expect(prompt).toContain('verified_this_turn');
    expect(prompt).toContain('compliance-ssts-circular230');
  });
});
