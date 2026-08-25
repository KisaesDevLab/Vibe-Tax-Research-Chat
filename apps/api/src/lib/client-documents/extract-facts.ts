// TP-3a — LLM fact-candidate extraction. Input pages are ALREADY Shield-
// redacted (ingest.ts enforces the ordering); the forced-tool schema plus
// per-item zod filtering keeps malformed candidates out of the database.
// Invalid items are dropped and logged, never fatal.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClientDocType, FactCandidate } from '@vibe/shared';
import { FACT_SECTIONS } from '@vibe/shared';
import { factCandidateEmitSchema } from '@vibe/schema';
import { callClaude } from '../anthropic/client.js';
import { getExtractionProtocol } from '../facts/extraction/index.js';
import { logger } from '../logger.js';
import type { DocumentPage } from './pages.js';

const SHARED_SYSTEM = `You extract fact-pattern candidates from a tax document for a CPA's client file.

Rules:
- Emit candidates ONLY via the emit_fact_candidates tool.
- Every candidate cites the page its evidence appears on ([[page N]] markers delimit pages).
- PII discipline is absolute: never emit names, SSNs, EINs, addresses, or birthdates in any field. Owners are initials or role labels; dependents are age bands. Redaction placeholders like [REDACTED-SSN] must never appear in a value.
- path is a fact-schema path: a scalar path ('entity.type', 'household.filingStatus') sets a value; an array path ('ownership[]', 'carryforwards[]') appends the object in value.
- value must match the fact schema for that path (enums exactly as specified in the form guide).
- display is a short human label for the review screen, e.g. "S election effective 2020-01-01".
- Emit only facts the document actually evidences. No inferences beyond the form guide's rules. Fewer, well-grounded candidates beat many speculative ones.`;

const emitArraySchema = z.array(factCandidateEmitSchema);

export interface ExtractFactsArgs {
  documentId: string;
  docType: ClientDocType;
  taxYear: number | null;
  pages: DocumentPage[];
  actorUserId?: string | null;
}

export async function extractFactCandidates(args: ExtractFactsArgs): Promise<FactCandidate[]> {
  const protocol = getExtractionProtocol(args.docType);
  if (!protocol) return [];

  const included = args.pages.slice(0, protocol.maxPages);
  const pageText = included.map((p) => `[[page ${p.page}]]\n${p.text}`).join('\n\n');
  const maxPage = included.reduce((m, p) => Math.max(m, p.page), 1);

  const { response } = await callClaude(
    'fact-extract',
    {
      system: `${SHARED_SYSTEM}\n\nForm guide (${args.docType}${args.taxYear ? `, tax year ${args.taxYear}` : ''}):\n${protocol.systemGuide}`,
      messages: [{ role: 'user', content: pageText }],
      tools: [
        {
          name: 'emit_fact_candidates',
          description: 'Report every extracted fact candidate.',
          input_schema: {
            type: 'object' as const,
            properties: {
              candidates: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string' },
                    section: { type: 'string', enum: [...FACT_SECTIONS] },
                    value: {},
                    display: { type: 'string' },
                    page: { type: 'integer', minimum: 1 },
                  },
                  required: ['path', 'section', 'value', 'display', 'page'],
                },
              },
            },
            required: ['candidates'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'emit_fact_candidates' },
    },
    { actorUserId: args.actorUserId ?? null },
  );

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('fact-extract returned no tool_use block');
  }
  const raw = (toolUse.input as { candidates?: unknown }).candidates;
  const parsed = emitArraySchema.safeParse(raw);
  const items = parsed.success
    ? parsed.data
    : emitArraySchema.parse(
        // Salvage the valid subset when the array as a whole failed.
        Array.isArray(raw) ? raw.filter((c) => factCandidateEmitSchema.safeParse(c).success) : [],
      );
  const dropped = (Array.isArray(raw) ? raw.length : 0) - items.length;
  if (dropped > 0) {
    logger.warn(
      { document_id: args.documentId, dropped },
      'fact-extract: dropped malformed candidates',
    );
  }

  return items
    .filter((c) => c.page >= 1 && c.page <= maxPage)
    .map((c) => ({
      id: randomUUID(),
      path: c.path,
      section: c.section,
      value: c.value,
      display: c.display,
      sources: [{ documentId: args.documentId, page: c.page, method: 'extracted' as const }],
      status: 'pending' as const,
    }));
}
