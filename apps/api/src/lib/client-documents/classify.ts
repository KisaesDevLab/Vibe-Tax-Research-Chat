// TP-3a — docType classification. Header-form-number heuristic first (order
// matters: K-1 before its parent forms, 1120-S before 1120); local regexes
// over the REDACTED page-1 text. LLM fallback via the client-doc-classify
// job when the heuristic finds nothing — returns null on any failure so the
// caller keeps 'other'.
import { z } from 'zod';
import type { ClientDocType } from '@vibe/shared';
import { callClaude } from '../anthropic/client.js';
import { logger } from '../logger.js';

export interface DocTypeGuess {
  docType: ClientDocType;
  taxYear: number | null;
}

interface HeuristicRule {
  docType: ClientDocType;
  pattern: RegExp;
}

// First match wins. "Schedule K-1" appears on the K-1 itself while the
// parent 1120-S/1065 headers appear on page 1 of the parent return, so K-1
// leads; 1120-S must precede the bare 1120 pattern.
const RULES: HeuristicRule[] = [
  { docType: 'k1', pattern: /schedule\s+k-?1/i },
  { docType: 'f1120s', pattern: /form\s+1120-?s\b|\b1120-?S\b/ },
  { docType: 'f1065', pattern: /form\s+1065\b/i },
  { docType: 'f1120', pattern: /form\s+1120\b/i },
  { docType: 'f990', pattern: /form\s+990\b/i },
  { docType: 'f1040', pattern: /form\s+1040\b/i },
  {
    docType: 'state_return',
    pattern: /(form\s+(540|IT-201|MO-1040|D-400|IL-1040|PA-40))|state\s+income\s+tax\s+return/i,
  },
  { docType: 'engagement_letter', pattern: /engagement\s+letter/i },
];

const YEAR_RE = /\b(20\d{2})\b/;

export function classifyDocTypeHeuristic(pageOneText: string): DocTypeGuess | null {
  // The form header + year band lives at the top of page 1 — restrict the
  // year capture so a date deep in the page doesn't win.
  const headerBand = pageOneText.slice(0, 600);
  for (const rule of RULES) {
    if (rule.pattern.test(pageOneText)) {
      const yearMatch = YEAR_RE.exec(headerBand) ?? YEAR_RE.exec(pageOneText);
      const year = yearMatch ? Number(yearMatch[1]) : null;
      return { docType: rule.docType, taxYear: year };
    }
  }
  return null;
}

const DOC_TYPES = [
  'f1040',
  'f1120s',
  'f1120',
  'f1065',
  'k1',
  'f990',
  'state_return',
  'engagement_letter',
  'correspondence',
  'other',
] as const;

const llmResultSchema = z.object({
  doc_type: z.enum(DOC_TYPES),
  tax_year: z.number().int().min(1990).max(2100).nullable(),
});

export async function classifyDocTypeLlm(
  redactedPageOneText: string,
  actorUserId: string | null,
): Promise<DocTypeGuess | null> {
  try {
    const { response } = await callClaude(
      'client-doc-classify',
      {
        system:
          'Classify a tax document from its first page. Respond only via the classify_document tool.',
        messages: [
          {
            role: 'user',
            content: `First page of the document (PII redacted):\n\n${redactedPageOneText.slice(0, 6000)}`,
          },
        ],
        tools: [
          {
            name: 'classify_document',
            description: 'Report the document type and tax year.',
            input_schema: {
              type: 'object' as const,
              properties: {
                doc_type: { type: 'string', enum: [...DOC_TYPES] },
                tax_year: { type: ['integer', 'null'] },
              },
              required: ['doc_type', 'tax_year'],
            },
          },
        ],
        tool_choice: { type: 'tool', name: 'classify_document' },
      },
      { actorUserId },
    );
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return null;
    const parsed = llmResultSchema.safeParse(toolUse.input);
    if (!parsed.success) return null;
    return { docType: parsed.data.doc_type, taxYear: parsed.data.tax_year };
  } catch (err) {
    logger.warn({ err }, 'client-doc-classify LLM fallback failed');
    return null;
  }
}
