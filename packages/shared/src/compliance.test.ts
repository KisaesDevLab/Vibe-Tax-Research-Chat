import { describe, expect, it } from 'vitest';
import { complianceDisclosureForms, complianceText } from './compliance.js';

describe('complianceDisclosureForms', () => {
  it('reads the current and legacy array fields', () => {
    expect(complianceDisclosureForms({ disclosure_forms: ['8275', 'None'] })).toEqual(['8275']);
    expect(complianceDisclosureForms({ form_disclosure_required: ['Form 8886'] })).toEqual([
      'Form 8886',
    ]);
    expect(
      complianceDisclosureForms({ disclosure_forms: [], form_disclosure_required: ['8275'] }),
    ).toEqual(['8275']);
  });

  it('never throws on the non-array shapes the model emits', () => {
    expect(complianceDisclosureForms({ form_disclosure_required: false })).toEqual([]);
    expect(complianceDisclosureForms({ disclosure_forms: true })).toEqual([]);
    expect(complianceDisclosureForms({ disclosure_forms: 'None' })).toEqual([]);
    expect(complianceDisclosureForms({ disclosure_forms: 'N/A' })).toEqual([]);
    expect(complianceDisclosureForms({ disclosure_forms: '8275, 8886' })).toEqual(['8275', '8886']);
    expect(complianceDisclosureForms({ disclosure_forms: [null, 8275, { form: 'x' }] })).toEqual([
      '8275',
      '{"form":"x"}',
    ]);
    expect(complianceDisclosureForms(null)).toEqual([]);
  });
});

describe('complianceText', () => {
  it('renders anything as a string', () => {
    expect(complianceText('HIGH')).toBe('HIGH');
    expect(complianceText(false)).toBe('');
    expect(complianceText(null)).toBe('');
    expect(complianceText({ level: 'HIGH' })).toBe('{"level":"HIGH"}');
  });
});
