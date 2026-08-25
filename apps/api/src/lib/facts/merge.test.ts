import { describe, expect, it } from 'vitest';
import type { DocumentCandidateDTO, FactCandidate } from '@vibe/shared';
import { emptyFactPattern } from '@vibe/shared';
import { validateFactPattern } from '@vibe/schema';
import { applyCandidates, computeConflicts, draftChangeSummary } from './merge.js';

const DOC_A = '11111111-1111-4111-8111-111111111111';
const DOC_B = '22222222-2222-4222-8222-222222222222';

function candidate(
  partial: Partial<FactCandidate> & Pick<FactCandidate, 'path' | 'value'>,
): FactCandidate {
  return {
    id: partial.id ?? crypto.randomUUID(),
    path: partial.path,
    section: partial.section ?? 'entity',
    value: partial.value,
    display: partial.display ?? String(partial.path),
    sources: partial.sources ?? [{ documentId: DOC_A, page: 1, method: 'extracted' }],
    status: partial.status ?? 'pending',
  };
}

describe('applyCandidates', () => {
  it('sets scalars with provenance on the section node and appends arrays', () => {
    const facts = applyCandidates(null, [
      { candidate: candidate({ path: 'entity.type', value: 's_corp' }), value: 's_corp' },
      {
        candidate: candidate({
          path: 'ownership[]',
          section: 'ownership',
          value: { owner: 'A.B.', pct: 60, role: 'shareholder', relatedParty: true },
          sources: [{ documentId: DOC_B, page: 3, method: 'extracted' }],
        }),
        value: { owner: 'A.B.', pct: 60, role: 'shareholder', relatedParty: true },
      },
    ]);
    expect(facts.entity.type).toBe('s_corp');
    expect(facts.entity.sources).toEqual([{ documentId: DOC_A, page: 1, method: 'extracted' }]);
    expect(facts.ownership).toHaveLength(1);
    expect(facts.ownership[0]!.sources).toEqual([
      { documentId: DOC_B, page: 3, method: 'extracted' },
    ]);
    expect(validateFactPattern(facts).ok).toBe(true);
  });

  it('dedupes identical appends and merges their provenance', () => {
    const value = { code: 's_election', since: '2020' };
    const facts = applyCandidates(null, [
      {
        candidate: candidate({
          path: 'electionsInEffect[]',
          section: 'electionsInEffect',
          value,
          sources: [{ documentId: DOC_A, page: 1, method: 'extracted' }],
        }),
        value,
      },
      {
        candidate: candidate({
          path: 'electionsInEffect[]',
          section: 'electionsInEffect',
          value,
          sources: [{ documentId: DOC_B, page: 2, method: 'extracted' }],
        }),
        value,
      },
    ]);
    expect(facts.electionsInEffect).toHaveLength(1);
    expect(facts.electionsInEffect[0]!.sources).toHaveLength(2);
  });

  it('never writes provenance onto income (income.sources is data)', () => {
    const facts = applyCandidates(null, [
      {
        candidate: candidate({ path: 'income.notes', section: 'income', value: 'K-1 heavy' }),
        value: 'K-1 heavy',
      },
      {
        candidate: candidate({ path: 'income.characters[]', section: 'income', value: 'se' }),
        value: 'se',
      },
    ]);
    expect(facts.income.notes).toBe('K-1 heavy');
    expect(facts.income.characters).toEqual(['se']);
    expect(facts.income.sources).toEqual([]); // untouched data array
    expect(validateFactPattern(facts).ok).toBe(true);
  });

  it('dependents append without sources and edited values win', () => {
    const facts = applyCandidates(emptyFactPattern(), [
      {
        candidate: candidate({
          path: 'household.dependents[]',
          section: 'household',
          value: { ageBand: '6_12', relationship: 'child' },
        }),
        value: { ageBand: '13_17', relationship: 'child' }, // staff edit
      },
    ]);
    expect(facts.household.dependents).toEqual([{ ageBand: '13_17', relationship: 'child' }]);
    expect(validateFactPattern(facts).ok).toBe(true);
  });

  it('skips broken paths without throwing', () => {
    const facts = applyCandidates(null, [
      { candidate: candidate({ path: 'nonsense.deep.path', value: 1 }), value: 1 },
      { candidate: candidate({ path: 'entity.type', value: 'individual' }), value: 'individual' },
    ]);
    expect(facts.entity.type).toBe('individual');
    expect(validateFactPattern(facts).ok).toBe(true);
  });
});

describe('computeConflicts', () => {
  function dto(documentId: string, path: string, value: unknown): DocumentCandidateDTO {
    return {
      document_id: documentId,
      filename: documentId === DOC_A ? 'a.pdf' : 'b.pdf',
      doc_type: 'f1040',
      tax_year: 2024,
      candidate: candidate({
        path,
        value,
        sources: [{ documentId, page: 1, method: 'extracted' }],
      }),
    };
  }

  it('flags same scalar path with differing values; arrays never conflict', () => {
    const groups = computeConflicts([
      dto(DOC_A, 'entity.type', 's_corp'),
      dto(DOC_B, 'entity.type', 'partnership'),
      dto(DOC_A, 'household.filingStatus', 'mfj'),
      dto(DOC_B, 'household.filingStatus', 'mfj'), // same value → no conflict
      dto(DOC_A, 'ownership[]', { owner: 'A', pct: 50, role: 'shareholder' }),
      dto(DOC_B, 'ownership[]', { owner: 'A', pct: 60, role: 'shareholder' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.path).toBe('entity.type');
    expect(groups[0]!.candidates).toHaveLength(2);
  });
});

describe('draftChangeSummary', () => {
  it('names documents and counts edits', () => {
    const c = candidate({ path: 'entity.type', value: 's_corp' });
    const summary = draftChangeSummary(
      [
        { candidate: c, value: 's_corp' },
        { candidate: candidate({ path: 'household.filingStatus', value: 'mfj' }), value: 'mfs' },
      ],
      [{ id: DOC_A, filename: '1040_2024.pdf' }],
    );
    expect(summary).toBe('Accepted 2 facts from 1040_2024.pdf; edited 1');
  });
});
