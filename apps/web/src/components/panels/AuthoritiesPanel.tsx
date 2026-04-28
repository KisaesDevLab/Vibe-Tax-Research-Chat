// Phase 18 — authorities panel.
import type { Authority } from '@vibe/shared';

export function AuthoritiesPanel({ authorities }: { authorities: Authority[] }) {
  if (!authorities || authorities.length === 0) return null;
  return (
    <section className="border border-ink/10 rounded mt-4 bg-white">
      <header className="px-4 py-2 border-b border-ink/10 font-display tracking-wide text-sm flex items-center justify-between">
        <span>Authorities</span>
        <span className="text-xs font-mono text-ink/50">{authorities.length} cited</span>
      </header>
      <ul className="divide-y divide-ink/5">
        {authorities.map((a, i) => (
          <li key={i} className="px-4 py-3 flex items-start justify-between gap-3 text-sm">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="citation-chip">{a.cite}</span>
                <span className="text-xs text-ink/50">{a.type}</span>
                <span className="text-xs text-ink/50">· weight: {a.weight}</span>
              </div>
              <div className="text-xs text-ink/60 mt-1 truncate">{a.source}</div>
              {a.warning && <div className="text-xs text-oxblood mt-1">⚠ {a.warning}</div>}
            </div>
            <VerificationChip authority={a} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function VerificationChip({ authority }: { authority: Authority }) {
  if (authority.verified_this_turn) {
    return <span className="text-xs px-2 py-0.5 rounded bg-moss/10 text-moss border border-moss/30">✓ verified this turn</span>;
  }
  if (authority.cache_age_seconds !== undefined) {
    return <span className="text-xs px-2 py-0.5 rounded bg-gold/10 text-gold border border-gold/30">⚠ cached</span>;
  }
  return <span className="text-xs px-2 py-0.5 rounded bg-oxblood/10 text-oxblood border border-oxblood/30">✗ unverified</span>;
}
