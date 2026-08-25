// TP-8a — plan-mode document citations. Rendered under the Authorities
// section: one row per document-grounded claim, with a grounded /
// unverified chip (grounded = the {documentId, page} pair appeared in the
// turn's retrieved excerpts) and click-through to the stored PDF at page.
// The optional onConfirm hook is the "Confirm as fact" entry point.
import type { DocCitation } from '@vibe/shared';
import { openDocumentAtPage } from '../../modules/clients/facts/SourceBadge';

export function DocCitationsPanel({
  citations,
  clientId,
  onConfirm,
}: {
  citations: DocCitation[];
  clientId: string | null;
  onConfirm?: (citation: DocCitation) => void;
}) {
  if (!citations || citations.length === 0) return null;
  return (
    <section>
      <h2 className="font-display text-xl mt-8 mb-3">Document citations</h2>
      <ul className="space-y-2">
        {citations.map((c, i) => (
          <li key={i} className="text-sm leading-relaxed">
            <div className="flex items-baseline gap-2 flex-wrap">
              {clientId ? (
                <button
                  onClick={() => void openDocumentAtPage(clientId, c.documentId, c.page)}
                  className="font-display underline underline-offset-2 hover:text-moss"
                >
                  {c.filename ?? 'Document'}, p.{c.page}
                </button>
              ) : (
                <span className="font-display">
                  {c.filename ?? 'Document'}, p.{c.page}
                </span>
              )}
              <span
                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  c.grounded ? 'bg-moss/15 text-moss' : 'bg-gold/15 text-gold'
                }`}
                title={
                  c.grounded
                    ? 'This page was among the excerpts retrieved for this turn'
                    : 'Cited page was NOT among the retrieved excerpts — verify before relying on it'
                }
              >
                {c.grounded ? 'grounded' : 'unverified'}
              </span>
              {onConfirm && (
                <button
                  onClick={() => onConfirm(c)}
                  className="text-xs underline underline-offset-2 text-ink/60 hover:text-ink"
                >
                  Confirm as fact
                </button>
              )}
            </div>
            <div className="text-xs text-ink/60 mt-0.5">{c.claim}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
