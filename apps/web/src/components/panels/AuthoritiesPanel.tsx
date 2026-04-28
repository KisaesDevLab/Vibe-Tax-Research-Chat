// Phase 18 — authorities section.
//
// Rendered as a document-style "Authorities" h2 section that matches the
// vertical rhythm of the rest of the response (Key Details / Planning
// Notes / etc.). Per-citation rows use the same body type as the prose,
// with the cite in display face, then a small metadata row, then the
// source URL — and a single status word in the right margin so readers
// can scan verification at a glance without the panel feeling like a
// separate card.
import type { Authority } from '@vibe/shared';

export function AuthoritiesPanel({ authorities }: { authorities: Authority[] }) {
  if (!authorities || authorities.length === 0) return null;
  return (
    <section>
      <h2 className="font-display text-xl mt-8 mb-3">Authorities</h2>
      <ol className="space-y-3 list-decimal pl-5 marker:text-ink/40">
        {authorities.map((a, i) => (
          <li key={i} className="leading-relaxed">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-display">{a.cite}</span>
              <Verification authority={a} />
            </div>
            <div className="text-xs text-ink/60 mt-0.5">
              <span className="capitalize">{a.type}</span>
              {a.weight && (
                <>
                  <span className="mx-1.5 text-ink/30">·</span>
                  <span>weight: {a.weight}</span>
                </>
              )}
              {a.retrieved_at && (
                <>
                  <span className="mx-1.5 text-ink/30">·</span>
                  <span>retrieved {new Date(a.retrieved_at).toLocaleDateString()}</span>
                </>
              )}
            </div>
            {a.source && (
              <div className="text-xs mt-0.5">
                {/^https?:\/\//.test(a.source) ? (
                  <a
                    href={a.source}
                    target="_blank"
                    rel="noreferrer"
                    className="text-oxblood hover:text-oxblood/80 break-all"
                  >
                    {a.source}
                  </a>
                ) : (
                  <span className="text-ink/60 break-all">{a.source}</span>
                )}
              </div>
            )}
            {a.warning && <div className="text-xs text-oxblood mt-1">⚠ {a.warning}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Verification({ authority }: { authority: Authority }) {
  if (authority.verified_this_turn) {
    return (
      <span className="text-xs text-moss font-mono uppercase tracking-wider whitespace-nowrap">
        ✓ verified
      </span>
    );
  }
  if (authority.cache_age_seconds !== undefined) {
    return (
      <span className="text-xs text-gold font-mono uppercase tracking-wider whitespace-nowrap">
        ⚠ cached
      </span>
    );
  }
  return (
    <span className="text-xs text-ink/40 font-mono uppercase tracking-wider whitespace-nowrap">
      unverified
    </span>
  );
}
