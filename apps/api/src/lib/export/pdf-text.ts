// WinAnsi text guards shared by every PDFKit renderer.
//
// Extracted from response-pdf.ts so the block renderers (pdf-blocks.ts) and
// the markdown renderer (render/markdown-pdf.ts) can sanitize without
// importing a whole document builder — importing response-pdf.ts from
// pdf-blocks.ts would also make the dependency circular.
//
// PDFKit's bundled base-14 fonts (Helvetica / Times / Courier) are
// WinAnsi-encoded (Windows-1252 plus a few CP1252 extras). Anything outside
// that codepage — emoji, mathematical operators, arrows, decorative
// checkmarks — renders as garbage glyphs ("→" prints as "!'", "≈" as "\"H",
// "🔑" as "Ø=Ý"). We can't fix the font without bundling a TrueType file, so
// we substitute the common offenders with ASCII approximations and strip
// everything else in the BMP/SMP symbol/emoji blocks. Section sign §, em-dash
// —, en-dash –, curly quotes "" '' • are all in WinAnsi 1252 and pass through
// untouched.
const UNICODE_FALLBACKS: Array<[RegExp, string]> = [
  [/[→➡➔➜➝➞➟]/gu, ' -> '],
  [/[←⬅]/gu, ' <- '],
  [/[↑]/gu, '^'],
  [/[↓]/gu, 'v'],
  [/[≈]/gu, '~'],
  [/[≤]/gu, '<='],
  [/[≥]/gu, '>='],
  [/[≠]/gu, '!='],
  [/[±]/gu, '+/-'],
  [/[×]/gu, 'x'],
  [/[÷]/gu, '/'],
  [/[✓✔☑]/gu, ''],
  [/[✗✘☒]/gu, ''],
  [/[⚠]/gu, ''],
  [/[★☆]/gu, '*'],
  // Box-drawing characters (U+2500-U+257F). Common in ASCII-art tables
  // / decision trees Claude emits inside fenced code blocks. Map by
  // shape so a horizontal divider stays a divider, a vertical bar stays
  // a bar, and corners/intersections collapse to `+`. Without this they
  // render as garbage glyphs ("%%%%") in WinAnsi-encoded fonts.
  [/[─━┄┅┈┉╌╍═]/gu, '-'],
  [/[│┃┆┇┊┋╎╏║]/gu, '|'],
  [/[┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╔╗╚╝╠╣╦╩╬]/gu, '+'],
  // Catch-all for the remaining dotted / dashed / partial glyphs in the
  // box-drawing block plus the block-elements block (U+2580-U+259F).
  [/[\u{2500}-\u{259F}]/gu, ''],
  // Emoji + miscellaneous symbol/dingbat blocks. Strip rather than guess.
  [/[\u{1F300}-\u{1FAFF}]/gu, ''],
  [/[\u{1F600}-\u{1F64F}]/gu, ''],
  [/[\u{1F680}-\u{1F6FF}]/gu, ''],
  [/[\u{1F700}-\u{1F77F}]/gu, ''],
  [/[\u{2600}-\u{27BF}]/gu, ''],
  [/[\u{1F900}-\u{1F9FF}]/gu, ''],
  // Variation selectors and zero-width joiners left dangling after emoji removal.
  // The ZWJ (U+200D) is matched via a separate alternative rather than inside
  // the character class: a joining char in a class trips eslint's
  // no-misleading-character-class. Behavior is identical — each is a single
  // code point stripped to ''.
  [/[\u{FE00}-\u{FE0F}\u{200B}\u{200C}]|\u{200D}/gu, ''],
];

// Coerce any value to a string at the sanitizer entry. Authorities and
// compliance_check are JSONB columns populated from the LLM's sidecar
// output, which is not strictly schema-validated — a rogue
// `{"cite": 1234}` or `{"note": {…}}` would otherwise crash the whole
// PDF with "out.replace is not a function". null/undefined become "",
// everything else goes through String() so numbers, booleans, and
// stringified objects render readably instead of vanishing.
export function toRenderString(s: unknown): string {
  if (typeof s === 'string') return s;
  if (s == null) return '';
  if (typeof s === 'object') {
    try {
      return JSON.stringify(s);
    } catch {
      return '';
    }
  }
  return String(s);
}

export function sanitizeForHelvetica(s: unknown): string {
  let out = toRenderString(s);
  for (const [re, rep] of UNICODE_FALLBACKS) out = out.replace(re, rep);
  // Collapse runs of whitespace that emoji-stripping may have left behind.
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Sanitizer for a single styled run inside a flowed paragraph.
 *
 * Same fallbacks, but it must NOT trim: a paragraph is drawn as a chain of
 * runs joined with `continued: true`, so the space that separates "…challenge
 * under " from a bold or linked run lives at the END of the preceding run.
 * Trimming it welds the words together ("challenge underReg. §1.162-1").
 * Internal whitespace runs are still collapsed, which is what emoji stripping
 * leaves behind.
 */
export function sanitizeRun(v: unknown): string {
  let out = toRenderString(v);
  for (const [re, rep] of UNICODE_FALLBACKS) out = out.replace(re, rep);
  return out.replace(/[ \t]{2,}/g, ' ');
}

// Same fallbacks as sanitizeForHelvetica but preserves whitespace, since
// alignment matters in ASCII-art code blocks (decision trees, formula
// tables, indented snippets). Trailing whitespace is trimmed but
// internal runs of spaces are kept verbatim.
export function sanitizeForCode(s: unknown): string {
  let out = toRenderString(s);
  for (const [re, rep] of UNICODE_FALLBACKS) out = out.replace(re, rep);
  return out.replace(/\s+$/, '');
}

/** Strip the inline markdown we render at block level rather than per-run. */
export function stripInline(s: unknown): string {
  return sanitizeForHelvetica(
    toRenderString(s)
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*\n]+?)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1'),
  );
}
