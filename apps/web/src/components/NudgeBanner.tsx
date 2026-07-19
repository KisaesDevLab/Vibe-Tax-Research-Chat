// TP-11 — dismissable "file to a client?" nudge shown on chats that are
// ≥90 days old, unlinked, and never archived.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArchiveNudgeDTO } from '@vibe/shared';
import { api } from '../lib/api';

export function NudgeBanner({
  chatId,
  onArchiveClick,
}: {
  chatId: string;
  onArchiveClick: () => void;
}) {
  const qc = useQueryClient();
  const { data } = useQuery<{ nudges: ArchiveNudgeDTO[] }>({
    queryKey: ['archive-nudges'],
    queryFn: () => api('/api/archives/nudges'),
    staleTime: 5 * 60 * 1000,
  });

  const dismiss = useMutation({
    mutationFn: () => api(`/api/archives/nudges/${chatId}/dismiss`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['archive-nudges'] }),
  });

  const isNudged = (data?.nudges ?? []).some((n) => n.id === chatId);
  if (!isNudged) return null;

  return (
    <div className="shrink-0 px-4 sm:px-6 md:px-7 py-2 bg-gold/10 border-b border-gold/30 flex items-center gap-3 text-sm">
      <span className="text-ink/70">
        This research session is over 90 days old and not filed to a client.
      </span>
      <button onClick={onArchiveClick} className="underline text-ink whitespace-nowrap">
        Archive to client…
      </button>
      <button
        onClick={() => dismiss.mutate()}
        className="ml-auto text-ink/40 hover:text-ink"
        aria-label="Dismiss nudge"
      >
        ×
      </button>
    </div>
  );
}
