// The model emits structured authorities + compliance payloads at the end
// of every research turn so the API can persist them and the panels below
// the prose can render them as formatted document blocks (not JSON walls).
// We strip these payloads from the prose before handing it to Markdown.
//
// Lifted out of pages/Chat.tsx so the archive viewer (and anything else that
// replays a stored transcript) strips the same four shapes the model produces
// in practice:
//   1. ```json authorities ... ```            (tagged-fence, the spec form)
//   2. ```authorities ... ```                 (no `json` keyword)
//   3. ```json\n{ "authorities": [...] }\n``` (generic JSON fence)
//   4. raw `{ "authorities": [...] }` with no fence at all
// All four occur in the wild because the system prompt asks for fenced
// blocks but the model doesn't always comply. We also have to handle the
// streaming case where the closing fence hasn't arrived yet — treat an
// unclosed authorities/compliance block as already strippable so users
// don't see a half-rendered JSON wall during streaming.
//
// Mirrored server-side in api/src/lib/parsing/sidecars-strip.ts (the PDF /
// clipboard exports need the identical behavior); keep the two in step.
const KEYWORD_RE = /authorities|compliance/i;

export function stripSidecars(text: string): string {
  let out = text;

  // Pass 1: fenced blocks. Match a fence that either has authorities/
  // compliance in its info string, OR has an authorities/compliance key
  // in the first ~200 chars of its body. The closing fence is optional
  // (matches end-of-string for in-flight streams).
  out = out.replace(/```([^\n]*)\n([\s\S]*?)(?:```|$)/g, (full, info: string, body: string) => {
    if (KEYWORD_RE.test(info)) return '';
    if (/^[a-z0-9]*$/i.test(info.trim()) && KEYWORD_RE.test(body.slice(0, 200))) return '';
    return full;
  });

  // Pass 2: bare JSON objects (no fence) at the end of the text whose
  // top-level key is "authorities" or "compliance" / "compliance_check".
  // We anchor with a positive look-back for a blank line or start of
  // string to avoid eating an inline `{ "authorities": ... }` mention.
  out = out.replace(
    /(^|\n\s*\n)\s*\{[\s\S]*?"(authorities|compliance|compliance_check)"\s*:[\s\S]*?\}\s*(?=\n\s*\n|\s*$)/g,
    (_full, lead: string) => lead,
  );

  // Pass 3: collapse the trailing whitespace + dividers we leave behind.
  return out
    .replace(/\n[\s-]*\n{2,}/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
