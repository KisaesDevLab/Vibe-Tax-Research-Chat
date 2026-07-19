# Exemplar Strategy Record — Augusta Rule (§280A(g))

Original authoring to Vibe schema v1.0. Demonstrates the expanded format; use as the
template for the other 99.

---

**id:** `augusta-rule` · **version:** 1.0.0 · **status:** draft · **effective:** 2026–
**category:** business-expenses · **modeled:** yes · **complexity:** 1 · **risk:** moderate
**entityTypes:** s-corp, partnership, c-corp · **savingsBand:** under-5k

## Advisor content

**Summary.** Section 280A(g) contains a bright-line exclusion: when a taxpayer's residence
is rented out for fewer than 15 days in a tax year, none of the rent is includible in gross
income — and none of the associated deductions are allowed. Paired with a §162 rent
deduction at the entity level, the owner's business can pay fair-market rent for genuine
business use of the owner's home (annual planning sessions, board meetings, staff training
days) and deduct it, while the owner receives the payment tax-free. The structure is well
established; what draws examination is pricing and proof. The strategy lives or dies on
rate support and meeting documentation, not on the statute.

**Mechanics.**

1. The exclusion applies per dwelling unit used as a residence: under 15 rental days in the
   year means the income never enters gross income and related deductions are denied to the
   owner (§280A(g)). Day 15 is a cliff — reaching it makes every rental dollar taxable.
2. The paying entity's deduction rests on §162: the rent must be ordinary, necessary, and
   reasonable in amount, which requires a documented business purpose for each rental day.
3. Rate-setting must reference daily-use comparables — hotel meeting rooms, coworking event
   space, banquet facilities of similar capacity — not residential monthly rent divided by 30. Quotes go in the file each year.
4. Each rental day needs contemporaneous substantiation: notice/agenda, minutes or work
   product, attendee list, an invoice from owner to entity, and a traceable payment.
5. A sole proprietorship cannot use this structure. With no separate payor entity, the
   owner is paying rent to themselves, and the §280A(a) disallowance leaves no deduction
   to claim. An S corporation, partnership, or C corporation payor is required.

**Authority.**

- IRC §280A(g) — the de minimis rental exclusion and companion deduction denial.
- IRC §162(a) — entity-side deduction standard; reasonableness in amount is part of the test.
- _Sinopoli v. Commissioner_, T.C. Memo 2023-105 — the Tax Court accepted the structure but
  cut rents of roughly $3,000 per meeting to about $500 where the taxpayers lacked
  comparable-rate evidence and credible proof the meetings occurred as claimed. The
  controlling lesson is evidentiary, not structural.
- IRC §280A(a) — the general disallowance that defeats the self-payor version.
- §274-style substantiation discipline — the documentation standard examiners apply to the
  business-purpose element in practice.

**Requirements.** Separate payor entity · ≤14 rental days per residence per year · genuine
business events with contemporaneous records · written invoice + actual payment ·
annual comparable-rate file.

**Risks.** Rate inflation is the primary audit theory (_Sinopoli_); expect an unsupported
premium daily rate to be re-set to a modest one on exam. Recurring "board meetings" of a
single-owner entity with no minutes invite full disallowance plus accuracy-related
penalties. The benefit ceiling is inherently modest — never let a client take an aggressive
position here for a four-figure deduction.

**State notes.** Most states conform to the federal exclusion through their federal-AGI
starting point; verify for non-conformity states in the client's footprint. Missouri
conforms (federal AGI start, RSMo §143.121) — no addback. No PTET interaction: the rent is
an entity deduction that reduces the income PTET is computed on, which the engine handles
automatically; do not double-count.

**Interactions.** _Requires:_ an existing pass-through or C-corp entity (pairs naturally
with `s-corp-election` for Schedule C clients — sequence the election first). _Synergies:_
`accountable-plan` (same documentation muscle), `board-fees-family` (same meetings can
serve both if genuinely substantive). _Conflicts:_ none, but coordinate with
`home-office-deduction` — the rented spaces and days must not overlap a claimed home office
use pattern in a way that undercuts either position.

**Review checklist (partner sign-off).**

- [ ] Payor is a separate entity in good standing; client is not Schedule C only
- [ ] Proposed daily rate tied to ≥2 current local comparables in the file
- [ ] Day count in the plan ≤ 14 and calendar-feasible for this client
- [ ] Client has accepted the documentation commitments in writing
- [ ] Modeled savings uses the client's actual marginal rate, not a placeholder

## Client content

**Teaser (pitch deck):** Your business pays for meeting space — this makes that money
tax-free income to you.

**Headline:** Rent your home to your own business, tax-free.

**Plain English.** There's a rule in the tax code with a famous nickname — the "Augusta
Rule," after the Georgia homeowners who rent their houses out during the Masters each
year. It says that if you rent your home out for 14 days or fewer in a year, you don't pay
tax on that rent. You don't even report it.

Your business already needs space for real meetings — annual planning, trainings, board
sessions. Instead of writing that check to a hotel, it can rent your home for those days
at the same going rate. The business deducts the rent like any other expense. You receive
it personally, tax-free.

The catch is discipline, not complexity: real meetings, real records, a defensible daily
rate, and a hard stop at 14 days. We set all of that up and give you the templates.

**Analogy.** Your business was going to pay someone for meeting space anyway. This rule
lets that someone be you — and unlike almost any other payment you can receive, this one
is tax-free.

**Benefits.** Up to 14 tax-free rental days per year · fully deductible to the business ·
no extra tax filings · repeats every year.

**Steps (us / you).** We document the market daily rate from local venue quotes and build
your meeting calendar and templates. You hold the meetings, keep the agenda and minutes we
provide, and have the business pay you by check or transfer.

**Client commitments.** Actually hold the meetings; complete the one-page minutes each
time; never exceed 14 days; keep payments traceable (no cash).

## Engagement

Effort: one-meeting setup + annual refresh · Maintenance: annual rate-comp refresh, day-count
monitoring at year-end · Deliverables to portal: corporate resolution, rate-comp memo,
meeting templates, annual summary schedule.

## Model

applyOrder 30 · Inputs: `days` (1–14, default 12), `dailyRate` ($ bound 100–2,500, default
from comp memo) · Apply: adds `days × dailyRate` to entity deductions (reduces
scheduleCNet is invalid — entity required; reduces passthroughK1 and qbiReduction by the
rent, since the deduction also reduces §199A qualified business income) · mayIncreaseBurden:
false.

Suggest rule: `passthroughK1 > 0 OR ownerWages > 0` (entity exists) AND homeowner flag →
"Client operates through an entity and owns a home — up to {days} days of §280A(g) rental
is available; model at a supported daily rate."

Golden test: MFJ, $200k K-1, 12 days × $600 → rent $7,200 reduces K-1 and QBI base;
expected federal+state delta computed against TABLES_2026 pinned values.

## Monitoring

Watch: IRC §280A, Tax Court memos citing 280A(g) · Keywords: "Augusta rule," "280A(g),"
"14 day rental exclusion" · Triggers: new case law; any OBBBA technical correction touching
§280A.
