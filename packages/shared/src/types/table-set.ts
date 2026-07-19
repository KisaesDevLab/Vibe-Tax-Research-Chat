// TP-4 — versioned table-set payload. Every constant the engine consumes
// is injected through this shape; the engine itself carries no year
// figures. Dollar amounts are whole dollars.
export type FilingStatus = 'single' | 'mfj' | 'mfs' | 'hoh';

export interface BracketRow {
  /** Marginal rate as a decimal, e.g. 0.22. */
  rate: number;
  /** Taxable-income ceiling for this row in dollars; null = no ceiling. */
  upTo: number | null;
}

export interface TableSetPayload {
  /** Ordinary-income brackets, ascending, last row upTo=null. */
  brackets: Record<FilingStatus, BracketRow[]>;
  /** Preferential-rate brackets (0 / 0.15 / 0.20), thresholds in taxable income. */
  capitalGainsBrackets: Record<FilingStatus, BracketRow[]>;
  standardDeduction: Record<FilingStatus, number>;
  seTax: {
    ssWageBase: number;
    ssRate: number; // combined employer+employee OASDI, e.g. 0.124
    medicareRate: number; // combined, e.g. 0.029
    addlMedicareRate: number; // 0.009
    addlMedicareThreshold: Record<FilingStatus, number>;
    /** §1402(a)(12) net-earnings factor, 0.9235. */
    netEarningsFactor: number;
  };
  qbi: {
    rate: number; // 0.20
    /** Taxable-income (pre-QBI) threshold where the wage/SSTB limits begin. */
    threshold: Record<FilingStatus, number>;
    /** Width of the phase-in range above the threshold (OBBBA: 75k/150k). */
    phaseInRange: Record<FilingStatus, number>;
    /** OBBBA minimum deduction for active QBI. */
    minDeduction: { amount: number; qbiFloor: number };
  };
  salt: {
    cap: Record<FilingStatus, number>;
    phaseDown: {
      magiThreshold: Record<FilingStatus, number>;
      /** Reduction = rate × (MAGI − threshold), e.g. 0.30. */
      reductionRate: number;
      floor: Record<FilingStatus, number>;
    };
  };
  ctc: {
    perChild: number;
    otherDependent: number;
    phaseOutThreshold: Record<FilingStatus, number>;
    /** $ reduction per $1,000 (or fraction) of MAGI over the threshold. */
    phaseOutPer1000: number;
  };
  niit: {
    rate: number;
    magiThreshold: Record<FilingStatus, number>;
  };
  passive: {
    /** §469(i) active-participation rental allowance. */
    rentalLossAllowance: number;
    phaseOutStart: number; // MAGI
    phaseOutEnd: number;
  };
  retirement: {
    limit402g: number;
    catchUp50: number;
    catchUp60to63: number;
    limit415c: number;
    limit415b: number;
    simpleLimit: number;
    simpleCatchUp50: number;
    hsaSelf: number;
    hsaFamily: number;
    hsaCatchUp: number;
    /** §401(a)(17) compensation cap (also SEP comp cap). */
    compCap: number;
    iraLimit: number;
    iraCatchUp: number;
  };
}

export interface TableSetSourceNote {
  group: string;
  authority: string;
  url?: string;
  note?: string;
}

export interface TableSetDTO {
  id: string;
  tax_year: number;
  version: number;
  status: 'draft' | 'published';
  payload: TableSetPayload;
  source_notes: TableSetSourceNote[];
  published_by: string | null;
  published_at: string | null;
  created_at: string;
}
