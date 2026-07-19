// TP-13 — per-job model pins and token budgets for every background
// Claude job. The budget is a HARD ceiling: callClaude clamps whatever a
// caller requests to the job's maxTokens, so a misbehaving prompt can
// never turn a title job into a 16k-token bill. Streaming chat is NOT
// governed here — it has its own per-model limits in the chat route.
export interface ClaudeJobConfig {
  model: string;
  /** Hard output-token ceiling for this job. */
  maxTokens: number;
  /** Default request timeout (ms). */
  timeoutMs: number;
}

export const CLAUDE_JOBS = {
  'chat-title': { model: 'claude-haiku-4-5', maxTokens: 64, timeoutMs: 15_000 },
  'attachment-summarize': { model: 'claude-haiku-4-5', maxTokens: 600, timeoutMs: 30_000 },
  'archive-title-tags': { model: 'claude-haiku-4-5', maxTokens: 128, timeoutMs: 10_000 },
  'skill-author': { model: 'claude-haiku-4-5', maxTokens: 4_096, timeoutMs: 120_000 },
  'skill-refine': { model: 'claude-haiku-4-5', maxTokens: 4_096, timeoutMs: 120_000 },
  'strategy-author': { model: 'claude-sonnet-4-5', maxTokens: 16_000, timeoutMs: 300_000 },
  // TP-14 currency jobs (declared ahead so budgets are reviewed once):
  'tables-draft': { model: 'claude-sonnet-4-5', maxTokens: 12_000, timeoutMs: 300_000 },
  'strategy-refresh': { model: 'claude-sonnet-4-5', maxTokens: 16_000, timeoutMs: 300_000 },
  'strategy-watch': { model: 'claude-haiku-4-5', maxTokens: 4_000, timeoutMs: 120_000 },
  'plan-memo': { model: 'claude-sonnet-4-5', maxTokens: 8_000, timeoutMs: 180_000 },
} as const satisfies Record<string, ClaudeJobConfig>;

export type ClaudeJobName = keyof typeof CLAUDE_JOBS;
