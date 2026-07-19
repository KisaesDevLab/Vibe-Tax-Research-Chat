// TP-12 — citation lint (gate 2). Every authority cite must parse
// against the format table for its type. The point is not legal
// completeness — it is catching malformed, hallucinated-shape, or
// mistyped cites before a human ever reviews the record.
import type { ValidationError } from './types.js';

interface AuthorityLike {
  type: string;
  cite: string;
}

/**
 * Format table. A cite passes when at least one pattern for its type
 * matches. Patterns are intentionally anchored to the *shape* of real
 * citations, not their substance.
 */
const FORMATS: Record<string, { patterns: RegExp[]; hint: string }> = {
  IRC: {
    patterns: [
      /^IRC §{1,2}\d+[A-Z]{0,2}(\([\w.]+\))*/, // IRC §280A(g), IRC §§1401-1402
      /^P\.L\. \d+-\d+/, // P.L. 119-21 (OBBBA) …
    ],
    hint: 'expected "IRC §<number>…" or "P.L. <congress>-<number>…"',
  },
  Reg: {
    patterns: [
      /^(Treas\. )?Reg\. §{1,2}\d+\.\d+/, // Reg. §1.162-7(b)(3)
      /^Prop\. Reg\. §{1,2}\d+\.\d+/,
    ],
    hint: 'expected "Reg. §<part>.<section>…"',
  },
  Case: {
    patterns: [
      // Party v. Party plus a reporter: T.C., T.C. Memo, T.C. Summ. Op.,
      // F.2d/F.3d/F.4th, F. Supp., U.S., B.T.A., AFTR
      /\sv\.?\s.+(T\.C\. Memo|T\.C\. Summ\. Op\.|\d+ T\.C\.|B\.T\.A\.|F\.[234]d|F\.4th|F\. Supp|U\.S\.|AFTR)/,
    ],
    hint: 'expected "<party> v. <party>, <reporter cite>" with a recognized reporter',
  },
  Admin: {
    patterns: [
      /^(Rev\. Proc\.|Rev\. Rul\.|Notice|IRS Notice|IRS Publication|Pub\. \d|Publication \d|Form |IRS Form|PLR |CCA |TAM |Announcement|FS-\d|IR-\d|Prop\. Reg\.|General Instructions)/,
      /(RSMo|Act|statutes?|instructions|principles|provisions|guidance)/i,
      /^IRC §/, // substantiation-principles style cross-references
    ],
    hint: 'expected an IRS pronouncement (Rev. Proc./Rev. Rul./Notice/Pub./Form/PLR…), statute, or instructions reference',
  },
};

export function lintCitation(authority: AuthorityLike): string | null {
  const format = FORMATS[authority.type];
  if (!format) return `unknown authority type "${authority.type}"`;
  const cite = authority.cite.trim();
  if (cite.length < 4) return 'cite is too short to be a real citation';
  if (!format.patterns.some((p) => p.test(cite))) {
    return `cite "${cite}" does not match any known ${authority.type} format — ${format.hint}`;
  }
  return null;
}

export function lintCitations(record: {
  advisor: { authority: AuthorityLike[] };
}): ValidationError[] {
  const errors: ValidationError[] = [];
  record.advisor.authority.forEach((a, i) => {
    const problem = lintCitation(a);
    if (problem) {
      errors.push({ gate: 'citation', path: `advisor.authority[${i}].cite`, message: problem });
    }
  });
  return errors;
}
