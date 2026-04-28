// Phase 20 — skills attribution panel.
import type { SkillAttribution } from '@vibe/shared';

export function SkillsPanel({ skills, max = 8 }: { skills?: SkillAttribution[]; max?: number }) {
  if (!skills || skills.length === 0) return null;
  return (
    <section className="border border-ink/10 rounded bg-white">
      <header className="px-4 py-2 border-b border-ink/10 flex items-center justify-between text-sm">
        <span className="font-display tracking-wide">Skills invoked this turn</span>
        <span className="font-mono text-xs text-ink/50">
          {skills.length} of {max} slots used
        </span>
      </header>
      <ul className="divide-y divide-ink/5 text-sm">
        {skills.map((s) => (
          <li key={s.skill_id} className="px-4 py-2 flex items-center gap-3">
            <span className={chipFor(s)}>{s.local_slug}</span>
            <span className="text-xs text-ink/50">{s.display_name}</span>
            <span className="ml-auto font-mono text-xs text-ink/40">v{s.version}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function chipFor(s: SkillAttribution): string {
  if (s.is_dispatcher) return 'citation-chip';
  if (s.is_compliance) return 'compliance-chip';
  return 'footnote-chip';
}
