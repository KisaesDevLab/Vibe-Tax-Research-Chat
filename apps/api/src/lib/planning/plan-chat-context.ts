// TP-8a — plan-mode chat context. Pure prompt assembly: the plan summary
// (memo-route style), the rendered fact snapshot (PII-free by schema
// design), the strategy under discussion, and the behavioral instruction
// block standing in for the not-yet-existing tax-planning-fact-pattern
// skill (QUESTIONS.md applied default — swap to skill routing when the
// pack ships).
import type { FactPattern, StrategySelection } from '@vibe/shared';
import { renderFactPattern } from '@vibe/shared';

export interface PlanChatContextArgs {
  plan: {
    title: string;
    status: string;
    years: number;
    growth_pct: string | number;
  };
  clientName: string;
  snapshot: { facts: FactPattern; fact_pattern_version: number; snapshot_kind: string } | null;
  strategyContent: {
    name?: string;
    advisor?: { summary?: string; authority?: Array<{ type: string; cite: string }> };
  } | null;
  scenarioSelections: StrategySelection[];
}

const INSTRUCTIONS = `Plan-scoped research mode:
- Summarize the relevant facts before advising; anchor every recommendation in the fact pattern above.
- Identify planning opportunities and the targeted follow-up questions a CPA should ask next.
- NEVER assert a client-specific fact that is not in the fact pattern unless a document excerpt supports it — cite the excerpt inline as [Doc: <filename>, p.<N>]. Facts neither on file nor documented are open questions, not assertions.
- External authorities keep the normal citation discipline and authorities sidecar.
- End every response with a fenced \`\`\`doc_citations code block containing a JSON array — one entry per document-grounded claim in the response, shaped {"documentId": "<uuid>", "filename": "<name>", "page": <n>, "claim": "<one-line restatement>"}. Emit [] when no claim rests on a client document. This block is machine-parsed and stripped before display.`;

export function buildPlanChatPreamble(args: PlanChatContextArgs): string {
  const parts: string[] = ['<plan_context>'];
  parts.push(
    `Plan: "${args.plan.title}" for client ${args.clientName} — status ${args.plan.status}, ` +
      `${args.plan.years}-year window, ${args.plan.growth_pct}% growth assumption.`,
  );
  if (args.scenarioSelections.length > 0) {
    parts.push(
      `Selected strategies: ${args.scenarioSelections.map((s) => s.strategyId).join(', ')}.`,
    );
  }
  if (args.snapshot) {
    parts.push('');
    parts.push(
      `Client fact pattern (snapshot ${args.snapshot.snapshot_kind}, v${args.snapshot.fact_pattern_version}):`,
    );
    parts.push(renderFactPattern(args.snapshot.facts));
  } else {
    parts.push('');
    parts.push(
      'No fact pattern is on file for this client yet — treat client-specific facts as open questions.',
    );
  }
  if (args.strategyContent) {
    parts.push('');
    parts.push(`Strategy under discussion: ${args.strategyContent.name ?? '(unnamed)'}`);
    if (args.strategyContent.advisor?.summary) {
      parts.push(args.strategyContent.advisor.summary);
    }
    const authorities = args.strategyContent.advisor?.authority ?? [];
    if (authorities.length > 0) {
      parts.push('Key authority: ' + authorities.map((a) => a.cite).join('; '));
    }
  }
  parts.push('');
  parts.push(INSTRUCTIONS);
  parts.push('</plan_context>');
  return parts.join('\n');
}
