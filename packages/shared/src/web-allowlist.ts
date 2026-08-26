// Phase 16 — locked domain allowlist for Anthropic web_search / web_fetch.
//
// This list is a COMPILE-TIME constant, baked into the tool definitions in
// `apps/api/src/lib/anthropic/chat.ts` and `jobs/handlers/currency.ts`. There
// is no admin route and no settings row behind it: extending coverage means
// editing this file, rebuilding @vibe/shared, and redeploying.
//
// Matching semantics (Anthropic server tools — see docs/web-resources.md):
//   - A listed domain covers itself AND all of its subdomains, so `mo.gov`
//     reaches both `dor.mo.gov` and `revisor.mo.gov` in one entry. That is why
//     most states below are a single bare state domain, not a pile of agency
//     hosts.
//   - A listed SUBdomain covers only itself: `dor.mo.gov` would NOT reach
//     `revisor.mo.gov`. Prefer the bare state domain unless the agency sits
//     off it.
//   - Plain ASCII hostnames only. No scheme, no port, no wildcard in the
//     domain itself. Non-ASCII look-alikes are a homograph risk and rejected.
//   - web_fetch matches on the DOMAIN ONLY — an entry carrying a path never
//     matches a fetch URL. Keep every entry path-free.
//   - An entry need not serve a homepage itself; it only has to be a valid
//     hostname whose subdomains are what we want. `ky.gov`, `newmexico.gov`,
//     `wyo.gov`, and `legislature.state.al.us` return nothing at their apex
//     but are the correct covers for the agencies beneath them.
//
// Two operational gotchas before adding entries:
//   - Request-level allowed_domains must be a SUBSET of any organization-level
//     allowlist configured in the Claude Console. An entry outside it fails the
//     whole request with a 400 naming the conflict — it does not degrade.
//   - web_search can return `request_too_large` when the domain filter list is
//     long. This list is deliberately compacted onto bare state domains to hold
//     the entry count down; prefer widening an existing entry over appending a
//     new one.
//
// A redirect that crosses a domain boundary needs BOTH sides listed, because
// the filter re-applies to the redirect target. Known case: Maryland's
// marylandtaxes.gov → marylandcomptroller.gov.

export interface WebAllowlistEntry {
  domain: string;
  /** Federal primary source, or a state/DC revenue agency or statutory code. */
  scope: 'federal' | 'state';
  /** Two-letter jurisdiction (including 'DC'). Present iff scope === 'state'. */
  jurisdiction?: string;
  description: string;
}

export const WEB_ALLOWLIST: ReadonlyArray<WebAllowlistEntry> = [
  // ---- Federal primary sources ----
  {
    domain: 'uscode.house.gov',
    scope: 'federal',
    description: 'USLM, IRC sections, Popular Name, Classification Tables',
  },
  { domain: 'ecfr.gov', scope: 'federal', description: 'Treasury Regulations (Title 26 CFR)' },
  {
    domain: 'federalregister.gov',
    scope: 'federal',
    description: 'TDs, proposed regs, IRS notices',
  },
  { domain: 'dawson.ustaxcourt.gov', scope: 'federal', description: 'Tax Court opinions' },
  {
    domain: 'irs.gov',
    scope: 'federal',
    description: 'IRS Bulletin, Rev. Procs, Rev. Ruls, Notices',
  },
  { domain: 'govinfo.gov', scope: 'federal', description: 'Public Law text' },

  // ---- States + DC: revenue agency and statutory code ----
  // One entry per state where the bare state domain covers both; a second entry
  // only where the DOR or the legislature sits off that domain.
  {
    domain: 'alabama.gov',
    scope: 'state',
    jurisdiction: 'AL',
    description: 'AL — Department of Revenue (revenue.alabama.gov)',
  },
  {
    domain: 'legislature.state.al.us',
    scope: 'state',
    jurisdiction: 'AL',
    description: 'AL — Code of Alabama (alison.legislature.state.al.us)',
  },
  {
    domain: 'alaska.gov',
    scope: 'state',
    jurisdiction: 'AK',
    description: 'AK — Department of Revenue, Tax Division (tax.alaska.gov)',
  },
  { domain: 'akleg.gov', scope: 'state', jurisdiction: 'AK', description: 'AK — Alaska Statutes' },
  {
    domain: 'azdor.gov',
    scope: 'state',
    jurisdiction: 'AZ',
    description: 'AZ — Arizona Department of Revenue',
  },
  {
    domain: 'azleg.gov',
    scope: 'state',
    jurisdiction: 'AZ',
    description: 'AZ — Arizona Revised Statutes',
  },
  {
    domain: 'arkansas.gov',
    scope: 'state',
    jurisdiction: 'AR',
    description: 'AR — Dept. of Finance and Administration (dfa.arkansas.gov)',
  },
  {
    domain: 'arkleg.state.ar.us',
    scope: 'state',
    jurisdiction: 'AR',
    description: 'AR — Arkansas Code',
  },
  {
    domain: 'ca.gov',
    scope: 'state',
    jurisdiction: 'CA',
    description: 'CA — FTB, CDTFA, and leginfo (Revenue & Taxation Code)',
  },
  {
    domain: 'colorado.gov',
    scope: 'state',
    jurisdiction: 'CO',
    description: 'CO — Dept. of Revenue and the General Assembly',
  },
  {
    domain: 'ct.gov',
    scope: 'state',
    jurisdiction: 'CT',
    description: 'CT — DRS (portal.ct.gov) and the General Assembly (cga.ct.gov)',
  },
  {
    domain: 'delaware.gov',
    scope: 'state',
    jurisdiction: 'DE',
    description: 'DE — Division of Revenue and the Delaware Code',
  },
  {
    domain: 'floridarevenue.com',
    scope: 'state',
    jurisdiction: 'FL',
    description: 'FL — Florida Department of Revenue',
  },
  {
    domain: 'leg.state.fl.us',
    scope: 'state',
    jurisdiction: 'FL',
    description: 'FL — Florida Statutes (Online Sunshine)',
  },
  {
    domain: 'georgia.gov',
    scope: 'state',
    jurisdiction: 'GA',
    description: 'GA — Georgia Department of Revenue (dor.georgia.gov)',
  },
  {
    domain: 'ga.gov',
    scope: 'state',
    jurisdiction: 'GA',
    description: 'GA — Georgia General Assembly (legis.ga.gov)',
  },
  {
    domain: 'hawaii.gov',
    scope: 'state',
    jurisdiction: 'HI',
    description: 'HI — Dept. of Taxation and the State Legislature',
  },
  {
    domain: 'idaho.gov',
    scope: 'state',
    jurisdiction: 'ID',
    description: 'ID — State Tax Commission and the State Legislature',
  },
  {
    domain: 'illinois.gov',
    scope: 'state',
    jurisdiction: 'IL',
    description: 'IL — Illinois Department of Revenue (tax.illinois.gov)',
  },
  {
    domain: 'ilga.gov',
    scope: 'state',
    jurisdiction: 'IL',
    description: 'IL — Illinois Compiled Statutes',
  },
  {
    domain: 'in.gov',
    scope: 'state',
    jurisdiction: 'IN',
    description: 'IN — Dept. of Revenue and the General Assembly (iga.in.gov)',
  },
  {
    domain: 'iowa.gov',
    scope: 'state',
    jurisdiction: 'IA',
    description: 'IA — Dept. of Revenue and the Iowa Legislature',
  },
  {
    domain: 'ksrevenue.gov',
    scope: 'state',
    jurisdiction: 'KS',
    description: 'KS — Kansas Department of Revenue',
  },
  {
    domain: 'kslegislature.gov',
    scope: 'state',
    jurisdiction: 'KS',
    description: 'KS — Kansas Statutes',
  },
  {
    domain: 'ky.gov',
    scope: 'state',
    jurisdiction: 'KY',
    description: 'KY — Dept. of Revenue and the LRC (revenue/legislature.ky.gov)',
  },
  {
    domain: 'louisiana.gov',
    scope: 'state',
    jurisdiction: 'LA',
    description: 'LA — Louisiana Department of Revenue',
  },
  {
    domain: 'legis.la.gov',
    scope: 'state',
    jurisdiction: 'LA',
    description: 'LA — Louisiana Revised Statutes',
  },
  {
    domain: 'maine.gov',
    scope: 'state',
    jurisdiction: 'ME',
    description: 'ME — Maine Revenue Services and the State Legislature',
  },
  {
    domain: 'maryland.gov',
    scope: 'state',
    jurisdiction: 'MD',
    description: 'MD — Maryland General Assembly (mgaleg.maryland.gov)',
  },
  {
    domain: 'marylandtaxes.gov',
    scope: 'state',
    jurisdiction: 'MD',
    description: 'MD — Comptroller of Maryland (redirects to marylandcomptroller.gov)',
  },
  {
    domain: 'marylandcomptroller.gov',
    scope: 'state',
    jurisdiction: 'MD',
    description: 'MD — Comptroller of Maryland (redirect target; both entries required)',
  },
  {
    domain: 'mass.gov',
    scope: 'state',
    jurisdiction: 'MA',
    description: 'MA — Department of Revenue (mass.gov/dor)',
  },
  {
    domain: 'malegislature.gov',
    scope: 'state',
    jurisdiction: 'MA',
    description: 'MA — Massachusetts General Laws',
  },
  {
    domain: 'michigan.gov',
    scope: 'state',
    jurisdiction: 'MI',
    description: 'MI — Michigan Department of Treasury',
  },
  {
    domain: 'legislature.mi.gov',
    scope: 'state',
    jurisdiction: 'MI',
    description: 'MI — Michigan Compiled Laws',
  },
  {
    domain: 'mn.gov',
    scope: 'state',
    jurisdiction: 'MN',
    description: 'MN — Office of the Revisor of Statutes (revisor.mn.gov)',
  },
  {
    domain: 'state.mn.us',
    scope: 'state',
    jurisdiction: 'MN',
    description: 'MN — Department of Revenue (revenue.state.mn.us)',
  },
  {
    domain: 'ms.gov',
    scope: 'state',
    jurisdiction: 'MS',
    description: 'MS — Dept. of Revenue (dor.ms.gov) and the Mississippi Code (legislature.ms.gov)',
  },
  {
    domain: 'mo.gov',
    scope: 'state',
    jurisdiction: 'MO',
    description: 'MO — Dept. of Revenue and the Revisor of Statutes (RSMo)',
  },
  {
    domain: 'mt.gov',
    scope: 'state',
    jurisdiction: 'MT',
    description: 'MT — Montana Department of Revenue (revenue.mt.gov)',
  },
  {
    domain: 'legmt.gov',
    scope: 'state',
    jurisdiction: 'MT',
    description: 'MT — Montana Code Annotated (leg.mt.gov redirects here)',
  },
  {
    domain: 'nebraska.gov',
    scope: 'state',
    jurisdiction: 'NE',
    description: 'NE — Nebraska Department of Revenue',
  },
  {
    domain: 'nebraskalegislature.gov',
    scope: 'state',
    jurisdiction: 'NE',
    description: 'NE — Nebraska Revised Statutes',
  },
  {
    domain: 'nv.gov',
    scope: 'state',
    jurisdiction: 'NV',
    description: 'NV — Nevada Department of Taxation (tax.nv.gov)',
  },
  {
    domain: 'leg.state.nv.us',
    scope: 'state',
    jurisdiction: 'NV',
    description: 'NV — Nevada Revised Statutes',
  },
  {
    domain: 'nh.gov',
    scope: 'state',
    jurisdiction: 'NH',
    description: 'NH — Dept. of Revenue Administration and the General Court',
  },
  {
    domain: 'nj.gov',
    scope: 'state',
    jurisdiction: 'NJ',
    description: 'NJ — Division of Taxation (nj.gov/treasury/taxation)',
  },
  {
    domain: 'njleg.state.nj.us',
    scope: 'state',
    jurisdiction: 'NJ',
    description: 'NJ — New Jersey Statutes',
  },
  {
    domain: 'newmexico.gov',
    scope: 'state',
    jurisdiction: 'NM',
    description: 'NM — Taxation and Revenue Dept. (tax.newmexico.gov)',
  },
  {
    domain: 'nmlegis.gov',
    scope: 'state',
    jurisdiction: 'NM',
    description: 'NM — New Mexico Statutes',
  },
  {
    domain: 'ny.gov',
    scope: 'state',
    jurisdiction: 'NY',
    description: 'NY — Dept. of Taxation and Finance (tax.ny.gov)',
  },
  {
    domain: 'nysenate.gov',
    scope: 'state',
    jurisdiction: 'NY',
    description: 'NY — Consolidated Laws (Tax Law)',
  },
  {
    domain: 'assembly.state.ny.us',
    scope: 'state',
    jurisdiction: 'NY',
    description: 'NY — Assembly bill and law text',
  },
  {
    domain: 'ncdor.gov',
    scope: 'state',
    jurisdiction: 'NC',
    description: 'NC — North Carolina Department of Revenue',
  },
  {
    domain: 'ncleg.gov',
    scope: 'state',
    jurisdiction: 'NC',
    description: 'NC — North Carolina General Statutes',
  },
  {
    domain: 'nd.gov',
    scope: 'state',
    jurisdiction: 'ND',
    description: 'ND — Office of State Tax Commissioner (tax.nd.gov)',
  },
  {
    domain: 'ndlegis.gov',
    scope: 'state',
    jurisdiction: 'ND',
    description: 'ND — North Dakota Century Code',
  },
  {
    domain: 'ohio.gov',
    scope: 'state',
    jurisdiction: 'OH',
    description: 'OH — Dept. of Taxation and the Ohio Revised Code (codes.ohio.gov)',
  },
  {
    domain: 'oklahoma.gov',
    scope: 'state',
    jurisdiction: 'OK',
    description: 'OK — Oklahoma Tax Commission (oklahoma.gov/tax)',
  },
  {
    domain: 'oklegislature.gov',
    scope: 'state',
    jurisdiction: 'OK',
    description: 'OK — Oklahoma Statutes',
  },
  {
    domain: 'oregon.gov',
    scope: 'state',
    jurisdiction: 'OR',
    description: 'OR — Oregon Department of Revenue (oregon.gov/dor)',
  },
  {
    domain: 'oregonlegislature.gov',
    scope: 'state',
    jurisdiction: 'OR',
    description: 'OR — Oregon Revised Statutes (served from the www subdomain)',
  },
  {
    domain: 'pa.gov',
    scope: 'state',
    jurisdiction: 'PA',
    description: 'PA — Department of Revenue (pa.gov/agencies/revenue)',
  },
  {
    domain: 'palegis.us',
    scope: 'state',
    jurisdiction: 'PA',
    description: 'PA — Pennsylvania Consolidated Statutes (legis.state.pa.us redirects here)',
  },
  {
    domain: 'ri.gov',
    scope: 'state',
    jurisdiction: 'RI',
    description: 'RI — Rhode Island Division of Taxation (tax.ri.gov)',
  },
  {
    domain: 'rilegislature.gov',
    scope: 'state',
    jurisdiction: 'RI',
    description: 'RI — Rhode Island General Laws',
  },
  {
    domain: 'sc.gov',
    scope: 'state',
    jurisdiction: 'SC',
    description: 'SC — South Carolina Department of Revenue (dor.sc.gov)',
  },
  {
    domain: 'scstatehouse.gov',
    scope: 'state',
    jurisdiction: 'SC',
    description: 'SC — South Carolina Code of Laws',
  },
  {
    domain: 'sd.gov',
    scope: 'state',
    jurisdiction: 'SD',
    description: 'SD — South Dakota Department of Revenue (dor.sd.gov)',
  },
  {
    domain: 'sdlegislature.gov',
    scope: 'state',
    jurisdiction: 'SD',
    description: 'SD — South Dakota Codified Laws',
  },
  {
    domain: 'tn.gov',
    scope: 'state',
    jurisdiction: 'TN',
    description: 'TN — Dept. of Revenue and the General Assembly (capitol.tn.gov)',
  },
  {
    domain: 'texas.gov',
    scope: 'state',
    jurisdiction: 'TX',
    description: 'TX — Comptroller and Texas Statutes (statutes.capitol.texas.gov)',
  },
  {
    domain: 'utah.gov',
    scope: 'state',
    jurisdiction: 'UT',
    description: 'UT — State Tax Commission and the Utah Code (le.utah.gov)',
  },
  {
    domain: 'vermont.gov',
    scope: 'state',
    jurisdiction: 'VT',
    description: 'VT — Dept. of Taxes and the Vermont Statutes',
  },
  {
    domain: 'virginia.gov',
    scope: 'state',
    jurisdiction: 'VA',
    description: 'VA — Virginia Tax and the Code of Virginia (law.lis.virginia.gov)',
  },
  {
    domain: 'wa.gov',
    scope: 'state',
    jurisdiction: 'WA',
    description: 'WA — Dept. of Revenue and the RCW (app.leg.wa.gov)',
  },
  {
    domain: 'wv.gov',
    scope: 'state',
    jurisdiction: 'WV',
    description: 'WV — West Virginia Tax Division (tax.wv.gov)',
  },
  {
    domain: 'wvlegislature.gov',
    scope: 'state',
    jurisdiction: 'WV',
    description: 'WV — West Virginia Code (code.wvlegislature.gov)',
  },
  {
    domain: 'wi.gov',
    scope: 'state',
    jurisdiction: 'WI',
    description: 'WI — Wisconsin Department of Revenue (revenue.wi.gov)',
  },
  {
    domain: 'wisconsin.gov',
    scope: 'state',
    jurisdiction: 'WI',
    description: 'WI — Wisconsin Statutes (docs.legis.wisconsin.gov)',
  },
  {
    domain: 'wyo.gov',
    scope: 'state',
    jurisdiction: 'WY',
    description: 'WY — Wyoming Department of Revenue (revenue.wyo.gov)',
  },
  {
    domain: 'wyoleg.gov',
    scope: 'state',
    jurisdiction: 'WY',
    description: 'WY — Wyoming Statutes',
  },
  {
    domain: 'dc.gov',
    scope: 'state',
    jurisdiction: 'DC',
    description: 'DC — Office of Tax and Revenue (otr.cfo.dc.gov)',
  },
  {
    domain: 'dccouncil.gov',
    scope: 'state',
    jurisdiction: 'DC',
    description: 'DC — D.C. Official Code (code.dccouncil.gov)',
  },
] as const;

export const WEB_ALLOWLIST_DOMAINS = WEB_ALLOWLIST.map((e) => e.domain);

/** Every jurisdiction with at least one reachable source, sorted. */
export const WEB_ALLOWLIST_JURISDICTIONS = [
  ...new Set(WEB_ALLOWLIST.filter((e) => e.scope === 'state').map((e) => e.jurisdiction!)),
].sort();

/**
 * The reachability paragraph injected into the chat system prompt.
 *
 * Rendered FROM the list above rather than restated by hand: a prompt that
 * describes coverage the allowlist doesn't actually have is worse than no
 * paragraph at all, because it invites the model to treat an empty result as a
 * tool malfunction instead of an out-of-scope source. Callers should cache this
 * — it is a pure function of a compile-time constant.
 */
export function describeReachableSources(): string {
  const federal = WEB_ALLOWLIST.filter((e) => e.scope === 'federal');
  const federalLines = federal.map((e) => `      - ${e.domain} — ${e.description}`).join('\n');
  return `Reachable sources (the web_search and web_fetch tools are restricted to this list;
anything outside it is silently omitted from results, NOT reported as an error):
  - Federal:
${federalLines}
  - State: the official revenue agency and statutory code for all ${WEB_ALLOWLIST_JURISDICTIONS.length}
    U.S. jurisdictions — every state plus the District of Columbia.
  - NOT reachable: commercial research services (CCH, Checkpoint, Bloomberg/BNA,
    Westlaw, Lexis), practitioner commentary and firm memoranda, news and blogs,
    municipal or local tax authorities, and non-U.S. sources. No search will ever
    return these, however many times you try.`;
}

// Per-turn budget defaults (Phase 16). Overridable per-model in the models table.
//
// Raised from 8/4 once the allowlist grew from 16 domains to all 50 states + DC:
// a multi-state question has to search and verify per jurisdiction, and the old
// ceiling made the model run out of budget mid-answer and fall back to memory.
// Anthropic's own guidance is that comparative or multi-entity research "can use
// 10 or more" searches. Web search bills $10/1,000 (so ~$0.10/turn at the cap);
// web fetch adds no charge beyond the tokens it pulls in.
export const DEFAULT_WEB_BUDGET = {
  fetches_per_turn: 12,
  searches_per_turn: 10,
} as const;
