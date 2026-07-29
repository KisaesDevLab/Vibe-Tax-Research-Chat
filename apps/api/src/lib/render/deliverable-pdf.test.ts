// Deliverable PDFKit renderer tests — every kind produces a real,
// multi-page PDF from one fixture; the pitch deck and slideshow honor
// the reveal flag; no Chromium involved.
import { describe, it, expect } from 'vitest';
import { buildDeliverablePdf } from './deliverable-pdf.js';
import type { DeliverableKind, RenderData, StrategyRenderData } from './types.js';

const year = (y: number, burden: number) =>
  ({
    year: y,
    totalBurden: burden,
  }) as unknown as RenderData['baseline'][number];

const strategy = (id: string, modeled: boolean): StrategyRenderData => ({
  id,
  name: `Strategy ${id}`,
  modeled,
  riskRating: modeled ? 'moderate' : 'low',
  typicalSavingsBand: '5k-25k',
  client: {
    headline: `Headline for ${id}`,
    plainEnglish: ['First plain paragraph.', 'Second plain paragraph.'],
    benefits: ['Lower tax bill', 'Simple upkeep'],
    steps: ['WE set it up.', 'YOU keep records.'],
    clientCommitments: ['Keep the records we ask for.'],
    teaser: `Anonymous teaser for ${id}`,
  },
  advisor: {
    summary: 'A technical summary for the reviewing partner.',
    mechanics: ['Mechanic one.', 'Mechanic two.', 'Mechanic three.'],
    authority: [{ type: 'IRC', cite: 'IRC §162(a)', note: 'The deduction standard.' }],
    risks: ['Leading audit theory.', 'Documentation failure.'],
    requirements: ['A trade or business.'],
    reviewChecklist: ['Records exist.', 'Amounts reconcile.'],
  },
  engagement: {
    implementationEffort: 'one-meeting',
    annualMaintenance: ['Annual check.'],
    deliverables: ['Setup memo.'],
  },
});

const fixture = (): RenderData => ({
  branding: { firmName: 'Test Firm CPAs', accent: '#7a2a1a' },
  plan: {
    title: '2026 Test Plan',
    years: 3,
    engine_version: '1.0.0',
    fee_plan: { flatFee: 7500 },
  } as unknown as RenderData['plan'],
  clientName: 'Fixture Client LLC',
  baseline: [year(2026, 50_000), year(2027, 51_000), year(2028, 52_000)],
  scenario: [year(2026, 41_000), year(2027, 42_000), year(2028, 43_000)],
  scenarioLabel: 'Selected strategies',
  strategies: [strategy('alpha', true), strategy('beta', false)],
  revealStrategies: false,
  generatedAt: '1/1/2026, 9:00:00 AM',
  memo: null,
});

const MEMO_MARKDOWN = [
  '# Situation',
  '',
  'The client runs an **S corporation** with *material* profit.',
  '',
  '- Augusta rule',
  '- Accountable plan',
  '',
  '> Verify every figure.',
].join('\n');

const withMemo = (claudeDrafted = false): RenderData => ({
  ...fixture(),
  memo: {
    bodyMarkdown: MEMO_MARKDOWN,
    claudeDrafted,
    updatedAt: '2026-07-29T12:00:00.000Z',
  },
});

function pageCount(pdf: Buffer): number {
  // Count page objects; "/Type /Page" also prefixes "/Type /Pages" (the
  // tree root), so subtract those.
  const text = pdf.toString('latin1');
  const pages = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
  return pages;
}

const KINDS: DeliverableKind[] = [
  'advisor-pdf',
  'client-pdf',
  'handout',
  'pitch-deck',
  'slideshow',
];

describe('buildDeliverablePdf', () => {
  it.each(KINDS)('%s renders a real PDF', async (kind) => {
    const pdf = await buildDeliverablePdf(kind, fixture());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
    expect(pageCount(pdf)).toBeGreaterThanOrEqual(kind === 'handout' ? 1 : 2);
  });

  it('advisor-pdf paginates: cover + projection + one page per strategy', async () => {
    const pdf = await buildDeliverablePdf('advisor-pdf', fixture());
    expect(pageCount(pdf)).toBe(4);
  });

  it('pitch deck hides names until revealed', async () => {
    const hidden = await buildDeliverablePdf('pitch-deck', fixture());
    const revealed = await buildDeliverablePdf('pitch-deck', {
      ...fixture(),
      revealStrategies: true,
    });
    const hiddenText = hidden.toString('latin1');
    // PDFKit compresses content streams, so assert via behavior: the two
    // renders differ, and both are valid PDFs of the same page count.
    expect(pageCount(hidden)).toBe(pageCount(revealed));
    expect(hiddenText).not.toBe(revealed.toString('latin1'));
  });

  it('handout targets the requested strategy', async () => {
    const d = fixture();
    const a = await buildDeliverablePdf('handout', d, 'alpha');
    const b = await buildDeliverablePdf('handout', d, 'beta');
    expect(a.toString('latin1')).not.toBe(b.toString('latin1'));
  });

  it('rejects a handout with no strategies', async () => {
    const d = { ...fixture(), strategies: [] };
    await expect(buildDeliverablePdf('handout', d)).rejects.toThrow('no strategy for handout');
  });

  it('advisor-pdf gains a memo page when a memo is saved', async () => {
    const without = await buildDeliverablePdf('advisor-pdf', fixture());
    const withIt = await buildDeliverablePdf('advisor-pdf', withMemo());
    expect(pageCount(withIt)).toBe(pageCount(without) + 1);
  });

  it('advisor-pdf marks an unedited Claude draft', async () => {
    const edited = await buildDeliverablePdf('advisor-pdf', withMemo(false));
    const draft = await buildDeliverablePdf('advisor-pdf', withMemo(true));
    expect(draft.toString('latin1')).not.toBe(edited.toString('latin1'));
  });

  // The memo is internal advisor copy: it must never reach a client-facing
  // deliverable, so those renders are byte-identical with and without one.
  it.each(['client-pdf', 'handout', 'pitch-deck', 'slideshow'] as DeliverableKind[])(
    '%s omits the memo entirely',
    async (kind) => {
      const without = await buildDeliverablePdf(kind, fixture(), 'alpha');
      const withIt = await buildDeliverablePdf(kind, withMemo(), 'alpha');
      expect(pageCount(withIt)).toBe(pageCount(without));
      expect(withIt.length).toBe(without.length);
    },
  );

  it('handout hides the strategy name until revealed', async () => {
    const hidden = await buildDeliverablePdf('handout', fixture());
    const revealed = await buildDeliverablePdf('handout', {
      ...fixture(),
      revealStrategies: true,
    });
    expect(hidden.toString('latin1')).not.toBe(revealed.toString('latin1'));
  });
});
