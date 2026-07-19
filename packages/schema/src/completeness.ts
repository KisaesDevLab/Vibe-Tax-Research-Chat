// TP-12 — completeness gate. Checks the authoring rules that are about
// coverage rather than shape: mechanics↔authority mapping, the three
// mandatory stateNotes topics, universal suggest coverage, and the
// modeled-strategy contract (order band, inputs schema, ≥2 goldens —
// the golden count itself is enforced by the zod schema).
import type { ValidationError } from './types.js';
import type { ValidStrategyRecord } from './strategy-record.js';

/** Extract §-style tokens ("§280A", "§162") from a prose statement. */
function sectionTokens(text: string): string[] {
  return (text.match(/§{1,2}\s?\d+[A-Z]{0,2}/g) ?? []).map((t) => t.replace(/§{1,2}\s?/, ''));
}

export function checkCompleteness(record: ValidStrategyRecord): ValidationError[] {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string) =>
    errors.push({ gate: 'completeness', path, message });

  // 1. Mechanics ↔ authority: any mechanic that names a code section must
  //    be backed by an authority entry citing that section. (Mechanics
  //    with no section reference are treated as supported narrative.)
  //    The cite side is tokenized leniently — "IRC §§702, 1366" covers
  //    both sections even though only the first carries the § mark.
  const citedSections = new Set(
    record.advisor.authority.flatMap((a) => [
      ...sectionTokens(a.cite),
      ...(a.cite.match(/\b\d+[A-Z]{0,2}\b/g) ?? []),
    ]),
  );
  record.advisor.mechanics.forEach((m, i) => {
    for (const token of sectionTokens(m)) {
      if (!citedSections.has(token)) {
        err(
          `advisor.mechanics[${i}]`,
          `mechanic cites §${token} but no authority entry covers it — no orphan assertions`,
        );
      }
    }
  });

  // 2. stateNotes must address conformity, PTET interaction, and Missouri.
  const stateText = record.advisor.stateNotes.join(' ').toLowerCase();
  if (!/conform/.test(stateText)) {
    err('advisor.stateNotes', 'stateNotes must address state conformity to the federal treatment');
  }
  if (!/ptet|pass-through entity tax/.test(stateText)) {
    err('advisor.stateNotes', 'stateNotes must address PTET interaction (or state there is none)');
  }
  if (!/missouri/.test(stateText)) {
    err('advisor.stateNotes', 'stateNotes must include the Missouri-specific note');
  }

  // 3. Universal suggest coverage: modeled → model.suggest (zod enforces
  //    the model block); advisory → top-level suggest (zod enforces).
  //    Here we only verify the reason template's field references parse.
  const suggest = record.modeled ? record.model?.suggest : record.suggest;
  if (suggest) {
    const refs = suggest.reason.match(/\{([^}]+)\}/g) ?? [];
    for (const ref of refs) {
      if (!/^\{(profile\.)?[A-Za-z0-9_.]+\}$/.test(ref)) {
        err('suggest.reason', `malformed template reference ${ref}`);
      }
    }
  }

  // 4. Modeled contract beyond shape: inputs schema must declare its
  //    properties, and golden expectations must be honest about sign.
  if (record.model) {
    const inputs = record.model.inputs as { properties?: Record<string, unknown> };
    if (!inputs.properties || Object.keys(inputs.properties).length === 0) {
      // Zero-parameter strategies are legal but must say so explicitly.
      if (inputs.properties === undefined) {
        err('model.inputs', 'inputs schema must declare a properties object (may be empty)');
      }
    }
    record.model.goldenTests.forEach((g, i) => {
      if (g.expect.totalBurdenDelta > 0 && record.model?.mayIncreaseBurden !== true) {
        err(
          `model.goldenTests[${i}]`,
          'golden expects a burden increase but mayIncreaseBurden is not declared',
        );
      }
    });
  }

  // 5. Interaction references must be kebab ids (shape is zod-checked);
  //    a strategy must not require or conflict with itself.
  const rel = record.advisor.interactions;
  for (const [key, list] of Object.entries(rel) as Array<[string, string[]]>) {
    if (list.includes(record.id)) {
      err(`advisor.interactions.${key}`, 'a strategy cannot reference itself');
    }
  }

  return errors;
}
