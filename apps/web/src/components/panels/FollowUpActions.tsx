// Phase 33 — chip-button row that follows the rendered "Next steps
// (follow-up routing)" markdown block on every assistant answer. Each
// click submits the bare verb as a new user turn; the dispatcher in the
// `cpa-pack-index` skill recognizes the verb and routes the conclusion
// to the destination skill.
import { useState } from 'react';
import { FOLLOW_UP_VERBS, type FollowUpGroup, type FollowUpVerb } from '../../lib/follow-up';

const GROUP_LABEL: Record<FollowUpGroup, string> = {
  package: 'Package',
  carry: 'Carry forward',
};

const GROUPS: readonly FollowUpGroup[] = ['package', 'carry'];

export function FollowUpActions({
  verbs,
  conclusionEcho,
  disabled,
  onPick,
}: {
  verbs: FollowUpVerb[];
  conclusionEcho?: string;
  disabled?: boolean;
  onPick: (verb: FollowUpVerb) => void;
}) {
  const [picked, setPicked] = useState<FollowUpVerb | null>(null);
  const present = new Set(verbs);
  const isLocked = disabled || picked !== null;

  const handle = (verb: FollowUpVerb) => {
    if (isLocked) return;
    setPicked(verb);
    onPick(verb);
  };

  return (
    <div className="border-t border-ink/10 pt-3">
      <div className="text-xs uppercase tracking-wider text-ink/50 mb-2">Follow up</div>
      {conclusionEcho && <div className="text-xs text-ink/60 italic mb-2">{conclusionEcho}</div>}
      <div className="space-y-2">
        {GROUPS.map((g) => {
          const inGroup = FOLLOW_UP_VERBS.filter((v) => v.group === g && present.has(v.verb));
          if (inGroup.length === 0) return null;
          return (
            <div key={g} className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-ink/40 w-28 shrink-0">
                {GROUP_LABEL[g]}
              </span>
              <div className="flex flex-wrap gap-2">
                {inGroup.map((v) => {
                  const isPicked = picked === v.verb;
                  return (
                    <button
                      key={v.verb}
                      type="button"
                      onClick={() => handle(v.verb)}
                      disabled={isLocked}
                      title={v.hint}
                      aria-label={`${GROUP_LABEL[g]} as ${v.label}`}
                      className={
                        'text-xs px-3 py-1 rounded-full border transition-colors ' +
                        (isPicked
                          ? 'bg-ink text-paper border-ink'
                          : 'border-ink/25 text-ink/70 hover:text-ink hover:border-ink/50 hover:bg-ink/5 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink/70 disabled:hover:border-ink/25')
                      }
                    >
                      {v.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
