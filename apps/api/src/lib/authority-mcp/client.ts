// Phase 36 — HTTP client for the appliance-side authority-mcp service.
//
// Mirrors the api↔authority-mcp wire shape from PR 3:
//   POST AUTHORITY_MCP_URL/tools/<name>  body: <tool input json>
//   200  { result: <tool output> }
//   400  { error: 'bad_input', detail }
//   404  { error: 'unknown_tool' }
//   501  { error: 'not_implemented', tool }
//   502  { error: 'upstream_failed', url, status }
//
// All error responses bubble up as `AuthorityMcpError` with the original
// status. The chat tool-use loop translates these into Anthropic
// tool_result blocks (with `is_error: true`) so Claude can decide whether
// to retry, fall back to web_fetch, or surface the failure.
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

export class AuthorityMcpError extends Error {
  constructor(
    public readonly tool: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`authority-mcp ${tool}: HTTP ${status}`);
    this.name = 'AuthorityMcpError';
  }
}

export interface AuthorityMcpToolResult {
  cite?: string;
  url?: string;
  text?: string;
  fromCache?: boolean;
  cacheAgeSeconds?: number;
  [key: string]: unknown;
}

const FETCH_TIMEOUT_MS = 30_000;

export async function callAuthorityMcp(
  toolName: string,
  input: unknown,
): Promise<AuthorityMcpToolResult> {
  const url = `${env.AUTHORITY_MCP_URL.replace(/\/+$/, '')}/tools/${encodeURIComponent(toolName)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input ?? {}),
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body — leave null so the error message stays clean
    }
    if (!res.ok) {
      logger.warn({ tool: toolName, status: res.status, body }, 'authority-mcp tool call failed');
      throw new AuthorityMcpError(toolName, res.status, body);
    }
    const wrapped = body as { result?: AuthorityMcpToolResult };
    return wrapped.result ?? {};
  } finally {
    clearTimeout(timer);
  }
}

export async function listAuthorityMcpTools(): Promise<
  Array<{ name: string; description: string; implemented: boolean }>
> {
  const url = `${env.AUTHORITY_MCP_URL.replace(/\/+$/, '')}/tools/list`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new AuthorityMcpError('tools/list', res.status, await res.text().catch(() => ''));
  }
  const body = (await res.json()) as {
    tools: Array<{ name: string; description: string; implemented: boolean }>;
  };
  return body.tools;
}
