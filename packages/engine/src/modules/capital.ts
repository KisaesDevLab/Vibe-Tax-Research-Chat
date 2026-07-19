// TP-4 — capital gain/loss netting with carryforward. Simplified per
// QUESTIONS.md: the carryforward is treated as long-term and ST/LT are
// netted against each other before the $3,000 ordinary-loss allowance.
// All cents.
export interface CapitalResult {
  /** Net amount included in ordinary income (ST gains or allowed loss). */
  ordinaryComponent: number;
  /** Net long-term gain taxed at preferential rates (≥ 0). */
  preferentialGain: number;
  carryforwardOut: number; // positive = loss carried forward
  netCapitalGain: number; // for the §199A net-capital-gain cap and NIIT
}

const ORDINARY_LOSS_LIMIT = 3000 * 100;

export function netCapital(
  shortTerm: number,
  longTerm: number,
  carryforwardIn: number,
): CapitalResult {
  const lt = longTerm - carryforwardIn;
  const st = shortTerm;
  const total = st + lt;

  if (total < 0) {
    const allowed = Math.max(total, -ORDINARY_LOSS_LIMIT);
    return {
      ordinaryComponent: allowed,
      preferentialGain: 0,
      carryforwardOut: -(total - allowed),
      netCapitalGain: 0,
    };
  }

  // Net position is a gain: cross-net ST and LT.
  const preferentialGain = Math.max(0, lt + Math.min(st, 0));
  const ordinaryComponent = Math.max(0, st + Math.min(lt, 0));
  return {
    ordinaryComponent,
    preferentialGain,
    carryforwardOut: 0,
    netCapitalGain: preferentialGain,
  };
}
