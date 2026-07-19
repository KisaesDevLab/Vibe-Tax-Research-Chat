# Vibe Tax Plan — Strategy Authoring Schema v1.0

Every strategy is a versioned record in Postgres, not a source file. This spec defines the
record shape, the authoring rules, and the validation gates a strategy must pass before it
can be published to a firm's library. It is written to be consumed by both human authors
and the Claude authoring pipeline (which drafts to this spec; humans review and publish).

## Design principles

1. **The engine does the math; the strategy declares the transform.** A strategy never
   computes tax. It transforms a client profile (adjustments, qbiReduction, ownerWages,
   otherCredits, corpTaxPaid, otherTaxes, ptetPaid, and category-specific hooks) and the
   deterministic engine computes the year. Claude never does arithmetic at runtime.
2. **Everything is versioned and pinned.** A generated plan stores the strategy version and
   table-set version it was computed with. Republishing a strategy never changes an issued plan.
3. **Advisory ≠ unmodeled forever.** Advisory strategies still carry an input schema and a
   qualitative impact statement so they render honestly in deliverables ("structural — savings
   not computed") rather than pretending to zero.
4. **Original prose only.** All advisor and client content is authored fresh. Citations,
   statutes, cases, and mechanics are facts; the words are ours.

## Record shape

```jsonc
{
  // ---- Identity & lifecycle ----
  "id": "augusta-rule", // kebab-case, immutable
  "version": "1.0.0", // semver; MAJOR = math change, MINOR = content, PATCH = typo
  "status": "draft", // draft | in-review | published | deprecated
  "effectiveTaxYears": { "from": 2026, "to": null }, // null = current
  "lastReviewed": "2026-07-16",
  "reviewedBy": null, // staff user id at publish time — required to publish
  "changeLog": [{ "version": "1.0.0", "date": "...", "note": "Initial authoring" }],

  // ---- Classification ----
  "name": "…",
  "category": "business-expenses", // one of the 10 category slugs
  "modeled": true, // drives whether apply() exists
  "complexity": 1, // 1 simple → 5 multi-year structural
  "riskRating": "low|moderate|elevated", // audit posture, drives review-gate strictness
  "entityTypes": ["s-corp", "partnership", "c-corp"], // who it can apply to
  "typicalSavingsBand": "under-5k|5k-25k|25k-100k|100k-plus|structural",

  // ---- Advisor content (technical view) ----
  "advisor": {
    "summary": "…", // 3–6 sentences, the elevator technical case
    "mechanics": ["…"], // ordered, each a complete statement
    "authority": [
      // typed citations; every mechanic must be supported
      { "type": "IRC|Reg|Case|Admin", "cite": "…", "note": "why it matters here" },
    ],
    "requirements": ["…"], // hard eligibility gates
    "risks": ["…"], // audit exposure + failure modes, honest
    "stateNotes": ["…"], // NEW: state conformity, PTET interplay, MO specifics
    "interactions": {
      // NEW: cross-strategy dependencies
      "requires": [], // e.g. augusta-rule requires a separate entity strategy or existing entity
      "conflictsWith": [], // mutually exclusive selections
      "synergiesWith": [], // pairs worth presenting together
    },
    "reviewChecklist": ["…"], // NEW: what the reviewing partner verifies before this
    // strategy ships in a client plan
  },

  // ---- Client content (deliverable view) ----
  "client": {
    "teaser": "…", // one line for the anonymized pitch deck
    "headline": "…",
    "plainEnglish": ["…"], // 2–4 short paragraphs, 8th-grade reading level
    "analogy": "…",
    "benefits": ["…"],
    "steps": ["…"], // what WE do and what THEY do, clearly split
    "clientCommitments": ["…"], // NEW: honest statement of the client's ongoing burden
  },

  // ---- Engagement economics (drives proposal module) ----
  "engagement": {
    "implementationEffort": "one-meeting|multi-step|structural",
    "annualMaintenance": ["…"], // recurring tasks → recurring fee justification
    "deliverables": ["…"], // what lands in the Connect portal zone
    "feeGuidanceBand": null, // optional per-firm override; default from savings band
  },

  // ---- Modeling (modeled strategies only) ----
  "model": {
    "applyOrder": 30, // composition order; documented bands below
    "inputs": {
      /* JSON Schema for strategy parameters, with defaults and bounds */
    },
    "apply": { "module": "augusta-rule@1.0.0" }, // reviewed TS module ref, loaded by version
    "suggest": {
      // declarative screening — REQUIRED for all strategies
      "all": [{ "field": "hasEntity", "op": "eq", "value": true }],
      "reason": "template string with {profile.*} interpolation",
    },
    "goldenTests": [
      // must pass before publish; re-run on every table update
      {
        "name": "…",
        "profile": {},
        "params": {},
        "expect": { "totalBurdenDelta": -3120, "tolerance": 1 },
      },
    ],
  },

  // ---- Maintenance pipeline hooks ----
  "monitoring": {
    "watchAuthorities": ["IRC §280A", "T.C. Memo search: 280A(g)"],
    "keywords": ["Augusta rule", "280A(g)", "personal residence rental 14 days"],
    "reviewTriggers": ["new case law", "Rev. Proc. annual amounts", "OBBBA technical corrections"],
  },
}
```

## applyOrder bands

| Band                    | Range | What runs here                                                              |
| ----------------------- | ----- | --------------------------------------------------------------------------- |
| Entity structure        | 10–19 | S-election, C-conversion, multi-entity — reshape the income character first |
| Compensation            | 20–29 | Reasonable comp, spouse/kids payroll, board fees                            |
| Deduction creation      | 30–49 | Augusta, accountable plan, HRA/ICHRA, §179/bonus, cost seg                  |
| Retirement              | 50–59 | Solo 401(k), DB/cash balance, mega backdoor                                 |
| Income timing/character | 60–69 | Harvesting, installment, bracket management                                 |
| Credits                 | 70–79 | R&D, WOTC, 45F/45S, state credits                                           |
| State/PTET              | 80–89 | PTET runs after federal picture is set                                      |

## Authoring rules

- Every claim in `mechanics` must map to an entry in `authority`. No orphan assertions.
- `risks` must include the leading audit theory and its best-known case or ruling where one exists.
- `stateNotes` must at minimum address: (a) state conformity to the federal treatment,
  (b) PTET interaction if any, (c) anything Missouri-specific flagged for the authoring firm.
- Client prose: no strategy is described as "loophole," "trick," or "secret." Confidence
  without hype. Reading level ≤ grade 9 (validated).
- `suggest` is mandatory even for advisory strategies — the screening pass is a core product
  feature, and 100/100 coverage is a differentiator over the reference implementation's 14/100.

## Validation gates (CI, in order)

1. **Schema** — record validates against the JSON Schema for this spec.
2. **Citation lint** — every authority cite parses to a known format; case cites checked
   against the citation table.
3. **Math smoke** — modeled: apply() runs against 6 canonical profiles without error and
   never increases `totalBurden` unless `mayIncreaseBurden: true` is declared (e.g. C-corp
   conversion edge cases).
4. **Golden tests** — exact expected deltas within tolerance, pinned to a table-set version.
5. **Prose checks** — reading level, banned-phrase list, required sections non-empty.
6. **Human review** — partner-level approval recorded; publish is blocked without it.

## Claude pipeline usage

- **Drafting:** Claude receives this spec + the strategy id + the category conventions and
  produces a complete draft record. Web search is permitted for authority verification only.
- **Annual refresh:** when a new table set (e.g. TABLES_2027) lands, every published strategy
  re-runs golden tests; failures open review tickets with Claude-drafted diffs.
- **Watch job:** weekly, Claude searches `monitoring.watchAuthorities` and `keywords`; hits
  open a review ticket with a summary and a proposed content diff. Nothing publishes silently.
