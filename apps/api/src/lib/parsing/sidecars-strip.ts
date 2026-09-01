// Server-side mirror of the client's sidecar stripper. Removes the
// authorities / compliance JSON the model emits at the end of a turn so
// the PDF / clipboard exports show only prose. The structured payloads
// already live in m.authorities + m.compliance_check and the export
// renders them as proper sections.
const KEYWORD_RE = /authorities|compliance|doc_citations|clarify/i;
// The clarify sidecar's body carries no tag word when the model drops the
// info string (a plain ```json fence, or no fence) — recognise it by its
// status value instead. Seen live: the interview card rendered as a JSON
// wall because only the tag word was matched.
const CLARIFY_BODY_RE = /"status"\s*:\s*"(?:asking|ready)"/i;

function isSidecarBody(head: string): boolean {
  return KEYWORD_RE.test(head) || CLARIFY_BODY_RE.test(head);
}

export function stripSidecars(text: string): string {
  let out = text;

  // Pass 1: any fenced block whose info string OR first ~200 bytes of
  // body contain authorities/compliance. Closing fence is optional so a
  // truncated stream still parses cleanly.
  out = out.replace(
    /```([^\n]*)\n([\s\S]*?)(?:```|$)/g,
    (full: string, info: string, body: string) => {
      if (KEYWORD_RE.test(info)) return '';
      if (/^[a-z0-9]*$/i.test(info.trim()) && isSidecarBody(body.slice(0, 200))) return '';
      return full;
    },
  );

  // Pass 2: bare top-level JSON objects ending the message that hold
  // authorities/compliance keys (model sometimes drops the fence).
  out = out.replace(
    /(^|\n\s*\n)\s*\{[\s\S]*?(?:"(?:authorities|compliance|compliance_check|doc_citations|clarify)"\s*:|"status"\s*:\s*"(?:asking|ready)")[\s\S]*?\}\s*(?=\n\s*\n|\s*$)/g,
    (_full, lead: string) => lead,
  );

  return out
    .replace(/\n[\s-]*\n{2,}/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
