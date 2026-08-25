// TP-5a — the seed current-version advance guard. The riskiest rule in the
// re-seed path: a wrong answer clobbers an admin-published version.
import { describe, expect, it } from 'vitest';
import { shouldAdvanceCurrentVersion } from './seed.js';

describe('shouldAdvanceCurrentVersion', () => {
  it('advances a seed-owned pointer to a higher semver', () => {
    expect(
      shouldAdvanceCurrentVersion({
        pointedChangeNote: 'seed',
        pointedSemver: '1.0.1',
        seededSemver: '1.1.0',
      }),
    ).toBe(true);
  });

  it('NEVER advances over an admin publish, regardless of semver', () => {
    for (const note of ['approved via review queue', '', null]) {
      expect(
        shouldAdvanceCurrentVersion({
          pointedChangeNote: note,
          pointedSemver: '1.0.1',
          seededSemver: '9.9.9',
        }),
      ).toBe(false);
    }
  });

  it('never advances sideways, downward, or on garbage', () => {
    expect(
      shouldAdvanceCurrentVersion({
        pointedChangeNote: 'seed',
        pointedSemver: '1.1.0',
        seededSemver: '1.1.0',
      }),
    ).toBe(false);
    expect(
      shouldAdvanceCurrentVersion({
        pointedChangeNote: 'seed',
        pointedSemver: '1.2.0',
        seededSemver: '1.1.9',
      }),
    ).toBe(false);
    expect(
      shouldAdvanceCurrentVersion({
        pointedChangeNote: 'seed',
        pointedSemver: '1.0.0',
        seededSemver: 'not-semver',
      }),
    ).toBe(false);
  });

  it('handles multi-digit components numerically', () => {
    expect(
      shouldAdvanceCurrentVersion({
        pointedChangeNote: 'seed',
        pointedSemver: '1.9.0',
        seededSemver: '1.10.0',
      }),
    ).toBe(true);
  });
});
