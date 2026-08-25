import { beforeEach, describe, expect, it, vi } from 'vitest';

const callClaudeMock = vi.fn();
vi.mock('../anthropic/client.js', () => ({
  callClaude: (...args: unknown[]) => callClaudeMock(...args),
}));

import { extractFactCandidates } from './extract-facts.js';

const DOC_ID = '33333333-3333-4333-8333-333333333333';

function claudeToolResponse(candidates: unknown[]) {
  return {
    response: {
      content: [{ type: 'tool_use', name: 'emit_fact_candidates', input: { candidates } }],
    },
    text: '',
    request_hash: 'x',
    response_hash: 'y',
  };
}

describe('extractFactCandidates', () => {
  beforeEach(() => callClaudeMock.mockReset());

  it('passes redacted page-tagged text and mints ids/sources/status', async () => {
    callClaudeMock.mockResolvedValue(
      claudeToolResponse([
        {
          path: 'entity.type',
          section: 'entity',
          value: 's_corp',
          display: 'Entity: S corporation',
          page: 1,
        },
      ]),
    );
    const out = await extractFactCandidates({
      documentId: DOC_ID,
      docType: 'f1120s',
      taxYear: 2024,
      pages: [{ page: 1, text: 'Form 1120-S — SSN [REDACTED-SSN]' }],
    });

    const [job, request] = callClaudeMock.mock.calls[0]! as [
      string,
      { messages: Array<{ content: string }>; tool_choice: unknown },
    ];
    expect(job).toBe('fact-extract');
    expect(request.messages[0]!.content).toContain('[[page 1]]');
    expect(request.messages[0]!.content).toContain('[REDACTED-SSN]');
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'emit_fact_candidates' });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'entity.type',
      status: 'pending',
      sources: [{ documentId: DOC_ID, page: 1, method: 'extracted' }],
    });
    expect(out[0]!.id).toBeTruthy();
  });

  it('drops malformed candidates and out-of-range pages, keeps valid ones', async () => {
    callClaudeMock.mockResolvedValue(
      claudeToolResponse([
        { path: 'entity.type', section: 'entity', value: 's_corp', display: 'ok', page: 1 },
        { path: '', section: 'entity', value: 'x', display: 'bad path', page: 1 },
        {
          path: 'entity.type',
          section: 'not_a_section',
          value: 'x',
          display: 'bad section',
          page: 1,
        },
        {
          path: 'household.filingStatus',
          section: 'household',
          value: 'mfj',
          display: 'ok',
          page: 99,
        },
      ]),
    );
    const out = await extractFactCandidates({
      documentId: DOC_ID,
      docType: 'f1040',
      taxYear: null,
      pages: [{ page: 1, text: 'Form 1040' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe('entity.type');
  });

  it('returns [] without calling Claude for docTypes with no protocol', async () => {
    const out = await extractFactCandidates({
      documentId: DOC_ID,
      docType: 'correspondence',
      taxYear: null,
      pages: [{ page: 1, text: 'Dear client' }],
    });
    expect(out).toEqual([]);
    expect(callClaudeMock).not.toHaveBeenCalled();
  });

  it('throws when the response has no tool_use block (caller degrades)', async () => {
    callClaudeMock.mockResolvedValue({
      response: { content: [{ type: 'text', text: 'nope' }] },
      text: 'nope',
      request_hash: 'x',
      response_hash: 'y',
    });
    await expect(
      extractFactCandidates({
        documentId: DOC_ID,
        docType: 'f1040',
        taxYear: null,
        pages: [{ page: 1, text: 'Form 1040' }],
      }),
    ).rejects.toThrow(/no tool_use/);
  });
});
