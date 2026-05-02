// Phase 36 — per-source web_resource_strategy.
//
// Each authoritative source can be set to:
//   anthropic — Claude calls Anthropic's web_fetch/web_search server-side
//               (v1 default; preserves the v1 chat behavior unchanged).
//   mcp       — Claude calls the appliance-side authority-mcp service via
//               a tool_use loop the api drives. Enables sub-100ms cached
//               lookups and keeps source bytes inside the firm's hardware.
//
// The full set of sources lives here so the admin UI, env validation,
// and chat plumbing all pull from the same source of truth.
import { getSetting, setSetting } from './settings-store.js';
import { SETTING_KEYS } from '@vibe/db/schema';

export const WEB_RESOURCE_SOURCES = [
  'usc',
  'cfr',
  'irb',
  'fr',
  'dawson',
  'govinfo',
  'state_dor',
] as const;

export type WebResourceSource = (typeof WEB_RESOURCE_SOURCES)[number];
export type WebResourceMode = 'anthropic' | 'mcp';
export type WebResourceStrategy = Record<WebResourceSource, WebResourceMode>;

export const DEFAULT_STRATEGY: WebResourceStrategy = {
  usc: 'anthropic',
  cfr: 'anthropic',
  irb: 'anthropic',
  fr: 'anthropic',
  dawson: 'anthropic',
  govinfo: 'anthropic',
  state_dor: 'anthropic',
};

// In v1.5, the only sources whose authority-mcp implementation actually
// exists. The admin UI uses this list to gate the "mcp" toggle —
// flipping a source whose impl is still a stub would just make Claude's
// tool calls hit a 501 and waste a turn.
export const MCP_IMPLEMENTED_SOURCES: ReadonlyArray<WebResourceSource> = ['usc', 'cfr'];

/**
 * Read the firm's strategy from the settings KV. Missing or partial
 * stored values are filled with `anthropic` so an admin who's only set
 * one source still gets a complete map back.
 */
export async function getWebResourceStrategy(): Promise<WebResourceStrategy> {
  const stored = await getSetting<Partial<WebResourceStrategy>>(SETTING_KEYS.WEB_RESOURCE_STRATEGY);
  if (!stored) return { ...DEFAULT_STRATEGY };
  const merged = { ...DEFAULT_STRATEGY };
  for (const src of WEB_RESOURCE_SOURCES) {
    const v = stored[src];
    if (v === 'anthropic' || v === 'mcp') merged[src] = v;
  }
  return merged;
}

/** Persist a complete strategy. Validated against the source allowlist. */
export async function setWebResourceStrategy(
  next: WebResourceStrategy,
  updated_by: string,
): Promise<void> {
  const cleaned: WebResourceStrategy = { ...DEFAULT_STRATEGY };
  for (const src of WEB_RESOURCE_SOURCES) {
    cleaned[src] = next[src] === 'mcp' ? 'mcp' : 'anthropic';
  }
  await setSetting(SETTING_KEYS.WEB_RESOURCE_STRATEGY, cleaned, { updated_by });
}
