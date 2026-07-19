// TP-3 — research tab. Shows the soft-linked chats now; archived research
// sessions (immutable snapshots) fill this in with TP-11.
import type { ClientDTO } from '@vibe/shared';

export function ResearchTab({ client, counts }: { client: ClientDTO; counts: { chats: number } }) {
  return (
    <div className="text-ink/50 border border-dashed border-ink/20 rounded p-8 text-center">
      {counts.chats > 0
        ? `${counts.chats} research chat${counts.chats === 1 ? ' is' : 's are'} soft-linked to ${client.name}. Archived sessions will appear here once research archival ships.`
        : 'No research linked yet. Set this client as active and start a research chat, or archive an existing session to file it here.'}
    </div>
  );
}
