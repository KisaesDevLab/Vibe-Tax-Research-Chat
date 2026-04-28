// Phase 16 — locked domain allowlist for Anthropic web_fetch.
// Admin can extend, but the seed list is the canonical primary-source set.

export const WEB_ALLOWLIST: ReadonlyArray<{ domain: string; description: string }> = [
  { domain: 'uscode.house.gov', description: 'USLM, IRC sections, Popular Name, Classification Tables' },
  { domain: 'ecfr.gov', description: 'Treasury Regulations (Title 26 CFR)' },
  { domain: 'federalregister.gov', description: 'TDs, proposed regs, IRS notices' },
  { domain: 'dawson.ustaxcourt.gov', description: 'Tax Court opinions' },
  { domain: 'irs.gov', description: 'IRS Bulletin, Rev. Procs, Rev. Ruls, Notices' },
  { domain: 'govinfo.gov', description: 'Public Law text' },

  // Top-10 state DORs (by population)
  { domain: 'ftb.ca.gov', description: 'California FTB' },
  { domain: 'tax.ny.gov', description: 'NY DTF' },
  { domain: 'comptroller.texas.gov', description: 'Texas Comptroller' },
  { domain: 'floridarevenue.com', description: 'Florida DOR' },
  { domain: 'tax.illinois.gov', description: 'Illinois DOR' },
  { domain: 'revenue.pa.gov', description: 'Pennsylvania DOR' },
  { domain: 'tax.ohio.gov', description: 'Ohio Department of Taxation' },
  { domain: 'nj.gov', description: 'NJ Division of Taxation (path: /treasury/taxation)' },
  { domain: 'dor.georgia.gov', description: 'Georgia DOR' },
  { domain: 'ncdor.gov', description: 'NC DOR' },
] as const;

export const WEB_ALLOWLIST_DOMAINS = WEB_ALLOWLIST.map((e) => e.domain);

// Per-turn budget defaults (Phase 16). Overridable per-model in the models table.
export const DEFAULT_WEB_BUDGET = {
  fetches_per_turn: 8,
  searches_per_turn: 4,
} as const;
