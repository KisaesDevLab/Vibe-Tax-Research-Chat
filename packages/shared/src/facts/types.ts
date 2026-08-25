// TP-3a — client-owned fact patterns. The canonical schema is the sibling
// fact-schema.json (semver-tagged); these types mirror it and a test guards
// the version constant against the JSON's tag. PII discipline is structural:
// no section admits names, SSNs, or birthdates (owners are role labels or
// initials; dependents carry age bands only).
//
// Provenance rides on the nearest object node as `sources?: FactSource[]`,
// not on every scalar leaf — this keeps evaluator selector paths clean
// (`facts.ownership[].relatedParty`, not `.relatedParty.value`).

export const FACT_SCHEMA_VERSION = '1.0.0';

export type FactSourceMethod = 'extracted' | 'tb_sync' | 'staff_entered' | 'chat_confirmed';

export interface FactSource {
  documentId: string;
  page: number;
  span?: [number, number];
  method: FactSourceMethod;
}

export type EntityType =
  | 'individual'
  | 'sole_prop'
  | 's_corp'
  | 'c_corp'
  | 'partnership'
  | 'smllc'
  | 'trust'
  | 'nonprofit'
  | 'other';

export interface EntityFacts {
  type?: EntityType | null;
  formationState?: string | null;
  fiscalYearEnd?: string | null; // "MM-DD"
  sCorpEffectiveDate?: string | null; // "YYYY-MM-DD"
  accountingMethod?: 'cash' | 'accrual' | 'hybrid' | null;
  notes?: string | null;
  sources?: FactSource[] | null;
}

export type OwnerRole = 'shareholder' | 'partner' | 'member' | 'officer' | 'trustee' | 'other';

export interface OwnershipFact {
  /** Role label or initials only — never a full legal name or SSN. */
  owner: string;
  pct: number;
  role: OwnerRole;
  relatedParty?: boolean | null;
  sources?: FactSource[] | null;
}

export type NexusBasis = 'domicile' | 'physical' | 'economic' | 'payroll' | 'property' | 'other';

export interface StateFootprintFact {
  state: string;
  nexusBasis: NexusBasis;
  ptetElected?: boolean | null;
  sources?: FactSource[] | null;
}

export type IncomeCharacter =
  | 'w2'
  | 'se'
  | 'k1_active'
  | 'k1_passive'
  | 'rental'
  | 'portfolio'
  | 'capital_gain'
  | 'retirement'
  | 'other';

export type IncomeBand = 'under_100k' | '100k_500k' | '500k_1m' | 'over_1m';

export interface IncomeSourceFact {
  label: string;
  character: IncomeCharacter;
  approxBand?: IncomeBand | null;
  sources?: FactSource[] | null;
}

export interface IncomeFacts {
  characters: IncomeCharacter[];
  sources: IncomeSourceFact[];
  notes?: string | null;
}

export interface ElectionFact {
  /** Convention: s_election, ptet_<STATE>, 475f, 1031, grouping_469, … */
  code: string;
  since?: string | null; // "YYYY"
  note?: string | null;
  sources?: FactSource[] | null;
}

export type CarryforwardType =
  | 'nol'
  | 'capital_loss'
  | 'charitable'
  | 'passive_loss'
  | 'foreign_tax_credit'
  | 'amt_credit'
  | 'other';

export interface CarryforwardFact {
  type: CarryforwardType;
  amount: number;
  expires?: string | null; // "YYYY"
  sources?: FactSource[] | null;
}

export type PropertyKind =
  | 'real_estate'
  | 'residential_rental'
  | 'commercial'
  | 'vehicle'
  | 'equipment'
  | 'intangible'
  | 'other';

export interface PropertyFact {
  kind: PropertyKind;
  description?: string | null;
  placedInService?: string | null; // "YYYY" or "YYYY-MM-DD"
  basis?: number | null;
  method?: 'macrs' | 'sl' | 'bonus' | 'sec179' | 'other' | null;
  sources?: FactSource[] | null;
}

export type AgeBand = 'under_6' | '6_12' | '13_17' | '18_23' | 'adult';

export interface DependentFact {
  /** Age band and relationship only — never names or birthdates. */
  ageBand?: AgeBand | null;
  relationship: 'child' | 'parent' | 'other';
}

export interface HouseholdFacts {
  filingStatus: 'single' | 'mfj' | 'mfs' | 'hoh' | null;
  dependents: DependentFact[];
  sources?: FactSource[] | null;
}

export type LifeEventKind =
  | 'marriage'
  | 'divorce'
  | 'birth'
  | 'death'
  | 'home_purchase'
  | 'home_sale'
  | 'relocation'
  | 'business_start'
  | 'business_sale'
  | 'retirement'
  | 'inheritance'
  | 'other';

export interface LifeEventFact {
  year: number;
  event: LifeEventKind;
  note?: string | null;
  sources?: FactSource[] | null;
}

export interface OpenQuestionFact {
  id?: string | null;
  question: string;
  raisedBy: 'staff' | 'system' | 'client';
  status: 'open' | 'answered' | 'dismissed';
  sources?: FactSource[] | null;
}

export interface FactPattern {
  entity: EntityFacts;
  ownership: OwnershipFact[];
  stateFootprint: StateFootprintFact[];
  income: IncomeFacts;
  electionsInEffect: ElectionFact[];
  carryforwards: CarryforwardFact[];
  property: PropertyFact[];
  household: HouseholdFacts;
  lifeEvents: LifeEventFact[];
  openQuestions: OpenQuestionFact[];
  narrative: string;
}

export const FACT_SECTIONS = [
  'entity',
  'ownership',
  'stateFootprint',
  'income',
  'electionsInEffect',
  'carryforwards',
  'property',
  'household',
  'lifeEvents',
  'openQuestions',
  'narrative',
] as const;

export type FactSectionKey = (typeof FACT_SECTIONS)[number];

export function emptyFactPattern(): FactPattern {
  return {
    entity: {},
    ownership: [],
    stateFootprint: [],
    income: { characters: [], sources: [] },
    electionsInEffect: [],
    carryforwards: [],
    property: [],
    household: { filingStatus: null, dependents: [] },
    lifeEvents: [],
    openQuestions: [],
    narrative: '',
  };
}

// ---------------------------------------------------------------------------
// Extraction candidates (persisted on client_documents.fact_candidates).
// Accept/reject state is embedded per candidate; the resolve endpoint writes
// the column back whole inside its transaction.

export type CandidateStatus = 'pending' | 'accepted' | 'rejected';

export interface FactCandidate {
  /** Minted at extraction time. */
  id: string;
  /** 'entity.type' | 'ownership[]' | 'household.filingStatus' | … */
  path: string;
  section: FactSectionKey;
  /** Proposed node value — a scalar for scalar paths, an object for `[]` appends. */
  value: unknown;
  /** Pre-rendered label for the review UI. */
  display: string;
  /** Always [{documentId, page, method: 'extracted'}] at extraction. */
  sources: FactSource[];
  status: CandidateStatus;
  editedValue?: unknown;
  resolvedBy?: string;
  resolvedAt?: string;
  resolvedFactPatternId?: string;
}

export type ClientDocType =
  | 'f1040'
  | 'f1120s'
  | 'f1120'
  | 'f1065'
  | 'k1'
  | 'f990'
  | 'state_return'
  | 'engagement_letter'
  | 'correspondence'
  | 'other';
