// TP-3a — per-form extraction protocol shape. The systemGuide is the
// in-repo stand-in for the tax-planning-fact-pattern skill's extraction
// protocol: which facts to pull, where they live on the form, and
// disambiguation rules. Prompts see only Shield-redacted text.
import type { ClientDocType } from '@vibe/shared';

export interface ExtractionProtocol {
  docType: ClientDocType;
  /** Cap on pages included in the prompt (front-loaded). */
  maxPages: number;
  /** Form-specific guidance appended to the shared extraction system prompt. */
  systemGuide: string;
}
