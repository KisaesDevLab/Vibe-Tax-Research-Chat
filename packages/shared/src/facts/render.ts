// TP-8a — compact text rendering of a fact pattern for LLM context (and
// anywhere else a one-screen summary is useful). PII-free by schema design,
// so the output is safe to place in a prompt as-is. Pure and deterministic.
import type { FactPattern } from './types.js';

function line(label: string, value: string | null | undefined): string | null {
  if (!value) return null;
  return `${label}: ${value}`;
}

function fmtAmount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function renderFactPattern(facts: FactPattern): string {
  const sections: string[] = [];

  const e = facts.entity;
  const entityBits = [
    e.type ?? null,
    e.formationState ? `formed in ${e.formationState}` : null,
    e.fiscalYearEnd ? `FYE ${e.fiscalYearEnd}` : null,
    e.sCorpEffectiveDate ? `S election effective ${e.sCorpEffectiveDate}` : null,
    e.accountingMethod ? `${e.accountingMethod} method` : null,
    e.notes ?? null,
  ].filter(Boolean);
  if (entityBits.length) sections.push(`Entity: ${entityBits.join('; ')}`);

  if (facts.ownership.length) {
    sections.push(
      'Ownership: ' +
        facts.ownership
          .map((o) => `${o.owner} ${o.pct}% (${o.role}${o.relatedParty ? ', related party' : ''})`)
          .join('; '),
    );
  }

  if (facts.stateFootprint.length) {
    sections.push(
      'State footprint: ' +
        facts.stateFootprint
          .map(
            (s) =>
              `${s.state} (${s.nexusBasis}${
                s.ptetElected == null ? '' : s.ptetElected ? ', PTET elected' : ', no PTET election'
              })`,
          )
          .join('; '),
    );
  }

  const inc = facts.income;
  const incomeBits: string[] = [];
  if (inc.characters.length) incomeBits.push(`characters: ${inc.characters.join(', ')}`);
  if (inc.sources.length) {
    incomeBits.push(
      'sources: ' +
        inc.sources
          .map((s) => `${s.label} (${s.character}${s.approxBand ? `, ${s.approxBand}` : ''})`)
          .join('; '),
    );
  }
  if (inc.notes) incomeBits.push(inc.notes);
  if (incomeBits.length) sections.push(`Income: ${incomeBits.join(' — ')}`);

  if (facts.electionsInEffect.length) {
    sections.push(
      'Elections in effect: ' +
        facts.electionsInEffect
          .map((el) => `${el.code}${el.since ? ` (since ${el.since})` : ''}`)
          .join('; '),
    );
  }

  if (facts.carryforwards.length) {
    sections.push(
      'Carryforwards: ' +
        facts.carryforwards
          .map(
            (c) => `${c.type} $${fmtAmount(c.amount)}${c.expires ? ` (expires ${c.expires})` : ''}`,
          )
          .join('; '),
    );
  }

  if (facts.property.length) {
    sections.push(
      'Property: ' +
        facts.property
          .map((p) => {
            const bits = [
              p.description ?? p.kind,
              p.description ? `(${p.kind})` : null,
              p.placedInService ? `placed in service ${p.placedInService}` : null,
              p.basis != null ? `basis $${fmtAmount(p.basis)}` : null,
              p.method ?? null,
            ].filter(Boolean);
            return bits.join(', ');
          })
          .join('; '),
    );
  }

  const h = facts.household;
  const hhBits = [
    h.filingStatus ? `filing ${h.filingStatus}` : null,
    h.dependents.length
      ? `${h.dependents.length} dependent(s): ` +
        h.dependents.map((d) => `${d.relationship}${d.ageBand ? ` (${d.ageBand})` : ''}`).join(', ')
      : null,
  ].filter(Boolean);
  if (hhBits.length) sections.push(`Household: ${hhBits.join('; ')}`);

  if (facts.lifeEvents.length) {
    sections.push(
      'Life events: ' +
        facts.lifeEvents
          .map((ev) => `${ev.year} ${ev.event}${ev.note ? ` (${ev.note})` : ''}`)
          .join('; '),
    );
  }

  const open = facts.openQuestions.filter((q) => q.status === 'open');
  if (open.length) {
    sections.push('Open questions:\n' + open.map((q) => `- ${q.question}`).join('\n'));
  }

  const narrative = line('Narrative', facts.narrative.trim() || null);
  if (narrative) sections.push(narrative);

  return sections.length ? sections.join('\n') : '(no facts recorded)';
}
