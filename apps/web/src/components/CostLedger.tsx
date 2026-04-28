// Phase 15 — cost ledger panel rendered under each assistant message.
import type { UsageBlock } from '@vibe/shared';

export function CostLedger({
  usage,
  cost_usd,
  model_id,
  provisional,
}: {
  usage?: Partial<UsageBlock>;
  cost_usd?: number;
  model_id?: string;
  provisional?: boolean;
}) {
  if (!usage) return null;
  return (
    <section className="border border-ink/10 rounded mt-4 bg-white">
      <header className="px-4 py-2 border-b border-ink/10 flex items-center justify-between text-sm">
        <span className="font-display tracking-wide">Cost</span>
        <span className="font-mono text-xs text-ink/50">{model_id ?? '—'}</span>
      </header>
      <div className="px-4 py-3 grid grid-cols-3 gap-3 text-sm">
        <Cell label="Input" value={usage.input_tokens} />
        <Cell label="Output" value={usage.output_tokens} />
        <Cell label="Cache W" value={usage.cache_creation_input_tokens} />
        <Cell label="Cache R" value={usage.cache_read_input_tokens} />
        <Cell label="Fetches" value={usage.web_fetch_calls} />
        <Cell label="Searches" value={usage.web_search_calls} />
      </div>
      <div className="px-4 py-2 border-t border-ink/10 flex items-center justify-between text-sm">
        <span className="text-xs uppercase tracking-wider text-ink/50">
          Total{provisional ? ' (provisional)' : ''}
        </span>
        <span className="font-mono">{format(cost_usd ?? 0)}</span>
      </div>
    </section>
  );
}

function Cell({ label, value }: { label: string; value?: number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink/50">{label}</div>
      <div className="font-mono">{value ?? 0}</div>
    </div>
  );
}

function format(n: number): string {
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
