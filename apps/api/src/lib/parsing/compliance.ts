// Phase 19 — extract compliance check from compliance-ssts-circular230 skill output.
import type { ComplianceCheck } from '@vibe/shared';
import { logger } from '../logger.js';

const SIDECAR_RE = /```(?:json)?\s+compliance\s*\n([\s\S]*?)\n```/i;

export function extractCompliance(text: string): ComplianceCheck | undefined {
  const m = text.match(SIDECAR_RE);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]!) as ComplianceCheck;
  } catch (err) {
    logger.warn({ err }, 'compliance sidecar JSON parse failed');
    return undefined;
  }
}
