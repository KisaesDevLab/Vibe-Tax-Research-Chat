// TP-3a — one field-level description of the fact schema, driving both the
// read view and the section editors. Mirrors packages/shared fact-schema
// 1.0.0; enum options must stay in sync with the zod gate or saves 400.
import type { FactPattern } from '@vibe/shared';

export type FieldKind = 'text' | 'number' | 'select' | 'checkbox';

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  options?: readonly string[];
  placeholder?: string;
}

export const ENTITY_FIELDS: FieldDef[] = [
  {
    key: 'type',
    label: 'Entity type',
    kind: 'select',
    options: [
      'individual',
      'sole_prop',
      's_corp',
      'c_corp',
      'partnership',
      'smllc',
      'trust',
      'nonprofit',
      'other',
    ],
  },
  { key: 'formationState', label: 'Formation state', kind: 'text', placeholder: 'MO' },
  { key: 'fiscalYearEnd', label: 'Fiscal year end', kind: 'text', placeholder: 'MM-DD' },
  {
    key: 'sCorpEffectiveDate',
    label: 'S election effective',
    kind: 'text',
    placeholder: 'YYYY-MM-DD',
  },
  {
    key: 'accountingMethod',
    label: 'Accounting method',
    kind: 'select',
    options: ['cash', 'accrual', 'hybrid'],
  },
  { key: 'notes', label: 'Notes', kind: 'text' },
];

export const OWNERSHIP_FIELDS: FieldDef[] = [
  { key: 'owner', label: 'Owner (label/initials)', kind: 'text' },
  { key: 'pct', label: '%', kind: 'number' },
  {
    key: 'role',
    label: 'Role',
    kind: 'select',
    options: ['shareholder', 'partner', 'member', 'officer', 'trustee', 'other'],
  },
  { key: 'relatedParty', label: 'Related party', kind: 'checkbox' },
];

export const STATE_FIELDS: FieldDef[] = [
  { key: 'state', label: 'State', kind: 'text', placeholder: 'MO' },
  {
    key: 'nexusBasis',
    label: 'Nexus basis',
    kind: 'select',
    options: ['domicile', 'physical', 'economic', 'payroll', 'property', 'other'],
  },
  { key: 'ptetElected', label: 'PTET elected', kind: 'checkbox' },
];

export const INCOME_CHARACTERS = [
  'w2',
  'se',
  'k1_active',
  'k1_passive',
  'rental',
  'portfolio',
  'capital_gain',
  'retirement',
  'other',
] as const;

export const INCOME_SOURCE_FIELDS: FieldDef[] = [
  { key: 'label', label: 'Source', kind: 'text' },
  { key: 'character', label: 'Character', kind: 'select', options: INCOME_CHARACTERS },
  {
    key: 'approxBand',
    label: 'Approx. band',
    kind: 'select',
    options: ['under_100k', '100k_500k', '500k_1m', 'over_1m'],
  },
];

export const ELECTION_FIELDS: FieldDef[] = [
  { key: 'code', label: 'Code', kind: 'text', placeholder: 's_election / ptet_MO / 475f' },
  { key: 'since', label: 'Since', kind: 'text', placeholder: 'YYYY' },
  { key: 'note', label: 'Note', kind: 'text' },
];

export const CARRYFORWARD_FIELDS: FieldDef[] = [
  {
    key: 'type',
    label: 'Type',
    kind: 'select',
    options: [
      'nol',
      'capital_loss',
      'charitable',
      'passive_loss',
      'foreign_tax_credit',
      'amt_credit',
      'other',
    ],
  },
  { key: 'amount', label: 'Amount', kind: 'number' },
  { key: 'expires', label: 'Expires', kind: 'text', placeholder: 'YYYY' },
];

export const PROPERTY_FIELDS: FieldDef[] = [
  {
    key: 'kind',
    label: 'Kind',
    kind: 'select',
    options: [
      'real_estate',
      'residential_rental',
      'commercial',
      'vehicle',
      'equipment',
      'intangible',
      'other',
    ],
  },
  { key: 'description', label: 'Description', kind: 'text' },
  { key: 'placedInService', label: 'Placed in service', kind: 'text', placeholder: 'YYYY-MM-DD' },
  { key: 'basis', label: 'Basis', kind: 'number' },
  {
    key: 'method',
    label: 'Method',
    kind: 'select',
    options: ['macrs', 'sl', 'bonus', 'sec179', 'other'],
  },
];

export const DEPENDENT_FIELDS: FieldDef[] = [
  {
    key: 'ageBand',
    label: 'Age band',
    kind: 'select',
    options: ['under_6', '6_12', '13_17', '18_23', 'adult'],
  },
  {
    key: 'relationship',
    label: 'Relationship',
    kind: 'select',
    options: ['child', 'parent', 'other'],
  },
];

export const LIFE_EVENT_FIELDS: FieldDef[] = [
  { key: 'year', label: 'Year', kind: 'number' },
  {
    key: 'event',
    label: 'Event',
    kind: 'select',
    options: [
      'marriage',
      'divorce',
      'birth',
      'death',
      'home_purchase',
      'home_sale',
      'relocation',
      'business_start',
      'business_sale',
      'retirement',
      'inheritance',
      'other',
    ],
  },
  { key: 'note', label: 'Note', kind: 'text' },
];

export const OPEN_QUESTION_FIELDS: FieldDef[] = [
  { key: 'question', label: 'Question', kind: 'text' },
  { key: 'raisedBy', label: 'Raised by', kind: 'select', options: ['staff', 'system', 'client'] },
  { key: 'status', label: 'Status', kind: 'select', options: ['open', 'answered', 'dismissed'] },
];

export interface ArraySectionDef {
  section: keyof FactPattern;
  title: string;
  fields: FieldDef[];
  /** Fresh row template for "Add". */
  empty: () => Record<string, unknown>;
}

export const ARRAY_SECTIONS: ArraySectionDef[] = [
  {
    section: 'ownership',
    title: 'Ownership',
    fields: OWNERSHIP_FIELDS,
    empty: () => ({ owner: '', pct: 0, role: 'shareholder' }),
  },
  {
    section: 'stateFootprint',
    title: 'State footprint',
    fields: STATE_FIELDS,
    empty: () => ({ state: '', nexusBasis: 'domicile' }),
  },
  {
    section: 'electionsInEffect',
    title: 'Elections in effect',
    fields: ELECTION_FIELDS,
    empty: () => ({ code: '' }),
  },
  {
    section: 'carryforwards',
    title: 'Carryforwards',
    fields: CARRYFORWARD_FIELDS,
    empty: () => ({ type: 'nol', amount: 0 }),
  },
  {
    section: 'property',
    title: 'Property',
    fields: PROPERTY_FIELDS,
    empty: () => ({ kind: 'real_estate' }),
  },
  {
    section: 'lifeEvents',
    title: 'Life events',
    fields: LIFE_EVENT_FIELDS,
    empty: () => ({ year: new Date().getFullYear(), event: 'other' }),
  },
  {
    section: 'openQuestions',
    title: 'Open questions',
    fields: OPEN_QUESTION_FIELDS,
    empty: () => ({ question: '', raisedBy: 'staff', status: 'open' }),
  },
];
