# Skills routing

How the dispatcher decides which skills to attach to a turn. Source: BUILD_PLAN §3.2,
§5 Phase 11.

## Constraint

Anthropic's `container.skills[]` accepts **at most 8** skills per request. The pack ships
33+, so a router is mandatory.

## Algorithm

`packages/shared/src/skills/routing.ts → selectSkills()`. Heuristic, deterministic, no
network calls.

1. **Always-attached** (~2 of 8 slots):
   - `cpa-pack-index` — the dispatcher itself, gives Claude a map of every other skill.
   - `compliance-ssts-circular230` — SSTS / Circular 230 checklist applied to every turn.
2. **Rule-table matches** against the user message:
   - IRC sections: `§ 199A`, `§ 174`, `§ 163(j)`, `§ 280E`, `§ 1031`, …
   - Form numbers: 1040, 1120-S, 1065, 990, 706, 709, 8275 / 8275-R / 8886
   - IRS notice/letter prefixes: `CP-2000`, `LT-11`, `Notice 2024-23`
   - Penalty / abatement / interest keywords
   - Treasury Reg patterns: `Treas. Reg. § 1.…`
   - Tax Court / DAWSON keywords
   - Loper Bright / Chevron / Skidmore terms
3. **State codes** (top-10 only initially): CA, NY, TX, FL, IL, PA, OH, NJ, GA, NC.
   Matched as 2-letter abbreviation OR full name (`California`, `Pennsylvania`).
4. **Custom-skill keywords**: every `custom_skills.routing_keywords[]` entry contributes a
   rule against its parent skill.
5. **Score + filter**: scores accumulate; the top 8 wins. Always-attached skills get +1000
   to guarantee inclusion.
6. **Fallback (off by default)**: a Haiku 4.5 classifier behind
   `settings.haiku_fallback_routing`. Activates when the heuristic's top score is 0 (no rule
   fired). Adds ~$0.0005 per turn when on.

## Tests

`routing.test.ts` exercises:

- always-attached invariants
- IRC § 199A → `irc-199a-qbi`
- "California … 540NR" → `state-ca`
- Cap of 8 with a dense multi-state, multi-§ message
- IRS notice prefix → `irs-notice-decoder`
- Custom-skill keyword routing

When the upstream pack ships its `examples/` directory, the test file should grow an
auto-generated case per example so routing stays in sync with the pack's intended use.

## Tuning

Edit `RULES` in `routing.ts`. The weight scale is purely relative; treat 9 as "very confident
match" and 5 as "consider". Always-attached skills are pinned at 1000 to keep the cap-of-8
math obvious.
