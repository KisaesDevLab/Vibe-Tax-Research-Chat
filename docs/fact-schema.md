# Client fact-pattern schema

Schema version: **1.0.0** (hand-maintained rendering; the canonical artifact is
`packages/shared/src/facts/fact-schema.json`, mirrored by the TS types in
`packages/shared/src/facts/types.ts` and the zod validator in
`packages/schema/src/fact-pattern.ts` — drift between them fails
`pnpm -r test`).

A fact pattern is one client-owned, versioned JSONB document
(`client_fact_patterns.facts`). Plans snapshot it at creation and at review
freeze (`plan_fact_snapshots`); plans never mutate the client record.

## PII discipline (structural)

The schema admits **no names, SSNs, EINs, or birthdates**:

- `ownership[].owner` is a role label or initials.
- `household.dependents[]` carries `ageBand` + `relationship` only.
- Document text is Shield-redacted (`lib/pii`) before storage and before any
  LLM call, so extraction can't see PII either.

## Provenance

`sources?: FactSource[]` rides on the **nearest object node** (a section
object or an array entry), not on every scalar leaf — evaluator selector paths
stay clean (`facts.ownership[].relatedParty`).

```
FactSource = { documentId: uuid, page: int ≥ 1, span?: [start, end],
               method: extracted | tb_sync | staff_entered | chat_confirmed }
```

A node with no sources is allowed (staff-entered) and renders with a distinct
badge. `tb_sync` is reserved — no T&B integration exists in this appliance.

## Sections

| Section               | Shape                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entity`              | `type` (individual, sole_prop, s_corp, c_corp, partnership, smllc, trust, nonprofit, other), `formationState`, `fiscalYearEnd` ("MM-DD"), `sCorpEffectiveDate` ("YYYY-MM-DD"), `accountingMethod` (cash, accrual, hybrid), `notes`                   |
| `ownership[]`         | `owner` (label), `pct` 0–100, `role` (shareholder, partner, member, officer, trustee, other), `relatedParty?`                                                                                                                                        |
| `stateFootprint[]`    | `state` (2-letter), `nexusBasis` (domicile, physical, economic, payroll, property, other), `ptetElected?`                                                                                                                                            |
| `income`              | `characters[]` + `sources[]` of `{label, character, approxBand?}` — characters: w2, se, k1_active, k1_passive, rental, portfolio, capital_gain, retirement, other; bands: under_100k, 100k_500k, 500k_1m, over_1m. Summary only, never engine fields |
| `electionsInEffect[]` | `code` (convention: `s_election`, `ptet_<STATE>`, `475f`, `1031`, `grouping_469`), `since?` ("YYYY"), `note?`                                                                                                                                        |
| `carryforwards[]`     | `type` (nol, capital_loss, charitable, passive_loss, foreign_tax_credit, amt_credit, other), `amount`, `expires?` ("YYYY")                                                                                                                           |
| `property[]`          | `kind` (real_estate, residential_rental, commercial, vehicle, equipment, intangible, other), `description?`, `placedInService?`, `basis?`, `method?` (macrs, sl, bonus, sec179, other)                                                               |
| `household`           | `filingStatus` (single, mfj, mfs, hoh — matches the engine's `FilingStatus`) or null, `dependents[]` of `{ageBand: under_6, 6_12, 13_17, 18_23, adult; relationship: child, parent, other}`                                                          |
| `lifeEvents[]`        | `year`, `event` (marriage, divorce, birth, death, home_purchase, home_sale, relocation, business_start, business_sale, retirement, inheritance, other), `note?`                                                                                      |
| `openQuestions[]`     | `question`, `raisedBy` (staff, system, client), `status` (open, answered, dismissed)                                                                                                                                                                 |
| `narrative`           | CPA free-form text                                                                                                                                                                                                                                   |

## Relationship to the engine profile

Facts and the engine profile (`plans.baseline_profile`) are separate. The
profile stays numeric and engine-shaped; the fact pattern is typed-but-
narrative. Intake populates both from the same parse; neither derives from the
other at runtime.

## Evaluator field namespace

TP-5a suggest rules address facts as `facts.<path>` with `[]` meaning "some
array element" (`facts.ownership[].relatedParty`,
`facts.household.dependents[]` + `exists`). The whitelist of legal paths lives
in `packages/schema/src/fact-paths.ts` and is drift-checked against the JSON
schema. A predicate over a missing fact evaluates `unknown`, never `false`.

## Versioning

Any change to section shapes, enums, or path semantics bumps the schema semver
and `FACT_SCHEMA_VERSION` in `packages/shared/src/facts/types.ts` together.
`client_fact_patterns.schema_version` records the tag each version was written
under.
