// Question mode — the interview card rendered under an assistant turn that
// carried a `clarify` sidecar. Two shapes:
//   asking  → the single question, a confidence meter, optional pick-list
//             buttons, and a reply box. Any answer is posted as the next
//             user message, so the transcript stays an ordinary chat.
//   ready   → the model's confidence summary + two-line plan, with a
//             "Proceed" button that sends the signal it is waiting for.
// Only the LATEST assistant message gets the interactive controls; earlier
// cards collapse to a read-only chip so a stale question can't be answered
// out of order.
import { useState, type FormEvent } from 'react';
import type { Clarification, ClarifyAnswer } from '@vibe/shared';

export const PROCEED_SIGNAL = 'Proceed.';

function pct(confidence: number): number {
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100);
}

// The "how the user responded" line above a user turn that came from the
// card: names the question it answers and whether the answer was a pick,
// a typed reply, or the go-ahead. Renders nothing for ordinary messages.
export function ClarifyAnswerLabel({ answer }: { answer: ClarifyAnswer | null | undefined }) {
  if (!answer) return null;
  if (answer.kind === 'proceed') {
    return (
      <span
        className="normal-case tracking-normal text-moss"
        title="Gave the go-ahead on a ready card"
      >
        · gave the go-ahead
      </span>
    );
  }
  return (
    <span
      className="normal-case tracking-normal text-ink/60"
      title={answer.kind === 'option' ? 'Picked one of the suggested choices' : 'Typed a reply'}
    >
      · {answer.kind === 'option' ? 'picked' : 'answered'}
      {answer.question ? (
        <>
          {' '}
          for <q className="italic">{answer.question}</q>
        </>
      ) : null}
    </span>
  );
}

export function ClarifyPanel({
  clarification: c,
  active,
  onAnswer,
}: {
  clarification: Clarification | null | undefined;
  /** True only for the latest assistant turn — enables the reply controls. */
  active: boolean;
  onAnswer?: (text: string, kind: ClarifyAnswer['kind']) => void;
}) {
  const [reply, setReply] = useState('');
  if (!c) return null;
  const p = pct(c.confidence);
  const interactive = active && typeof onAnswer === 'function';

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = reply.trim();
    if (!text || !onAnswer) return;
    setReply('');
    onAnswer(text, 'freeform');
  }

  if (!interactive) {
    return (
      <div className="text-[10px] uppercase tracking-wider text-ink/40">
        Question mode · {c.status === 'ready' ? 'ready to proceed' : 'clarifying'} · {p}% confident
      </div>
    );
  }

  return (
    <section
      className="border border-moss/40 bg-moss/5 rounded p-4 space-y-3"
      data-testid="clarify-panel"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-wider text-moss">
          {c.status === 'ready' ? 'Ready to proceed' : 'Clarifying question'}
        </div>
        <div
          className="flex items-center gap-2 text-[10px] text-ink/50"
          title="The model's stated confidence that it understands the question"
        >
          <div className="w-20 h-1.5 bg-ink/10 rounded overflow-hidden" aria-hidden>
            <div className="h-full bg-moss" style={{ width: `${p}%` }} />
          </div>
          <span className="font-mono">{p}%</span>
        </div>
      </div>

      {c.status === 'asking' ? (
        <>
          <div className="font-display text-base">{c.question}</div>
          {c.options && c.options.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {c.options.map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => onAnswer!(o, 'option')}
                  className="text-sm px-3 py-1.5 border border-ink/20 rounded bg-paper hover:border-moss hover:text-moss"
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <form onSubmit={submit} className="flex gap-2">
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={c.options?.length ? 'Or type a different answer…' : 'Type your answer…'}
              className="flex-1 px-3 py-1.5 border border-ink/20 rounded font-body text-sm bg-paper"
              aria-label="Answer the clarifying question"
            />
            <button
              type="submit"
              disabled={!reply.trim()}
              className="text-sm px-3 py-1.5 bg-ink text-paper rounded disabled:opacity-40"
            >
              Answer
            </button>
          </form>
        </>
      ) : (
        <>
          {c.summary && <div className="text-sm leading-relaxed">{c.summary}</div>}
          {c.plan && c.plan.length > 0 && (
            <ol className="text-sm list-decimal pl-5 space-y-0.5">
              {c.plan.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={() => onAnswer!(PROCEED_SIGNAL, 'proceed')}
              className="text-sm px-4 py-1.5 bg-moss text-paper rounded hover:bg-moss/90"
            >
              Proceed
            </button>
            <span className="text-xs text-ink/50">
              Not quite right? Reply below with what to change and it will keep asking.
            </span>
          </div>
        </>
      )}
    </section>
  );
}
