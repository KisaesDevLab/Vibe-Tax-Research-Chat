// Phase 34 — tool registry. The HTTP server reads this once and dispatches
// /tools/<name> POSTs through the matching handler. Each entry pairs the
// zod input schema with the implementation; `description` is surfaced on
// /tools/list so the api process knows the surface.
import { z } from 'zod';
import { uscLookup, uscInputSchema } from './usc.js';
import { cfrLookup, cfrInputSchema } from './cfr.js';
import {
  fr_searchInput,
  dawson_searchInput,
  irb_lookupInput,
  pl_lookupInput,
  state_dor_searchInput,
  frSearch,
  dawsonSearch,
  irbLookup,
  plLookup,
  stateDorSearch,
  NotImplementedError,
} from './stubs.js';

export interface ToolEntry<I = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  implemented: boolean;
  handler: (input: I) => Promise<unknown>;
}

export const TOOLS: Record<string, ToolEntry> = {
  usc_lookup: {
    name: 'usc_lookup',
    description: 'Fetch a U.S. Code section. Defaults to Title 26 (tax).',
    inputSchema: uscInputSchema,
    implemented: true,
    handler: (i) => uscLookup(i as Parameters<typeof uscLookup>[0]),
  },
  cfr_lookup: {
    name: 'cfr_lookup',
    description: 'Fetch a CFR section/part from eCFR. Defaults to Title 26.',
    inputSchema: cfrInputSchema,
    implemented: true,
    handler: (i) => cfrLookup(i as Parameters<typeof cfrLookup>[0]),
  },
  fr_search: {
    name: 'fr_search',
    description:
      'Search Federal Register entries by agency / date / query. (stub — falls through to web_fetch)',
    inputSchema: fr_searchInput,
    implemented: false,
    handler: () => frSearch(),
  },
  dawson_search: {
    name: 'dawson_search',
    description: 'Search U.S. Tax Court (DAWSON) opinions. (stub)',
    inputSchema: dawson_searchInput,
    implemented: false,
    handler: () => dawsonSearch(),
  },
  irb_lookup: {
    name: 'irb_lookup',
    description: 'Fetch an IRS Bulletin item by name (Rev. Rul., Notice, …). (stub)',
    inputSchema: irb_lookupInput,
    implemented: false,
    handler: () => irbLookup(),
  },
  pl_lookup: {
    name: 'pl_lookup',
    description: 'Fetch a Public Law plus its Classification Table entries. (stub)',
    inputSchema: pl_lookupInput,
    implemented: false,
    handler: () => plLookup(),
  },
  state_dor_search: {
    name: 'state_dor_search',
    description: 'Search a state DOR for guidance (top-10 states). (stub)',
    inputSchema: state_dor_searchInput,
    implemented: false,
    handler: () => stateDorSearch(),
  },
};

export { NotImplementedError };
