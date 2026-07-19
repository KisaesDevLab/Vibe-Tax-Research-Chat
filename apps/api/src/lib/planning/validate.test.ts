// QA round 2 — validateParams contract: required-ness is a COMPUTE-time
// gate, never a scenario-write gate (an incomplete selection must
// persist so the UI can collect params), while type/range/enum errors
// always reject.
import { describe, it, expect } from 'vitest';
import { validateParams, type InputsSchema } from './validate.js';

const schema: InputsSchema = {
  type: 'object',
  properties: {
    ownerWages: { type: 'number', minimum: 0, maximum: 500_000 },
    method: { type: 'string', enum: ['auto', 'manual'] },
  },
  required: ['ownerWages'],
};

describe('validateParams', () => {
  it('skips required-ness when checkRequired is false (scenario writes)', () => {
    expect(validateParams('s', {}, schema, { checkRequired: false })).toEqual([]);
  });

  it('enforces required-ness by default (compute)', () => {
    const errors = validateParams('s', {}, schema);
    expect(errors).toEqual([
      { strategyId: 's', field: 'ownerWages', message: 'required parameter missing' },
    ]);
  });

  it('always rejects wrong types and out-of-range values, even on writes', () => {
    const errors = validateParams('s', { ownerWages: -5, method: 'other' }, schema, {
      checkRequired: false,
    });
    expect(errors.map((e) => e.field).sort()).toEqual(['method', 'ownerWages']);
  });
});
