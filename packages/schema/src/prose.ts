// TP-12 — prose gates (gate 5). Client-facing sections must read at or
// below grade 9 (Flesch-Kincaid) and never use the hype vocabulary the
// authoring rules ban. Advisor sections are exempt from both: they are
// written for professionals, and terms of art ("guaranteed payments"
// under §707(c)) would false-positive a naive banned-word scan.
import type { ValidationError } from './types.js';

export const BANNED_WORDS = ['loophole', 'trick', 'secret', 'guarantee'] as const;

/** Max Flesch-Kincaid grade for client prose (docs/strategy-schema.md). */
export const MAX_CLIENT_GRADE = 9;

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch-Kincaid grade level of a prose passage. */
export function fleschKincaidGrade(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = text.match(/[A-Za-z0-9$%']+/g) ?? [];
  if (sentences.length === 0 || words.length === 0) return 0;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  return 0.39 * (words.length / sentences.length) + 11.8 * (syllables / words.length) - 15.59;
}

function findBanned(text: string): string[] {
  const hits: string[] = [];
  for (const word of BANNED_WORDS) {
    // Stem match: "guarantee" also catches "guaranteed"/"guarantees";
    // "trick" catches "tricks"/"trickery". Word-start boundary so
    // e.g. "restrict" never matches "trick".
    if (new RegExp(`\\b${word}`, 'i').test(text)) hits.push(word);
  }
  return hits;
}

interface ClientSections {
  client: {
    teaser: string;
    headline: string;
    plainEnglish: string[];
    analogy: string;
    benefits: string[];
    steps: string[];
    clientCommitments: string[];
  };
}

export function checkProse(record: ClientSections): ValidationError[] {
  const errors: ValidationError[] = [];

  // Reading level: measured over the client's real prose (paragraphs +
  // analogy). Fragmentary lists (benefits, steps) are excluded — FK is
  // meaningless on sentence fragments — but still banned-word scanned.
  const clientProse = [...record.client.plainEnglish, record.client.analogy].join(' ');
  const grade = fleschKincaidGrade(clientProse);
  if (grade > MAX_CLIENT_GRADE) {
    errors.push({
      gate: 'prose',
      path: 'client.plainEnglish',
      message: `client prose reads at grade ${grade.toFixed(1)} — must be ≤ ${MAX_CLIENT_GRADE}`,
    });
  }

  const scan: Array<[string, string]> = [
    ['client.teaser', record.client.teaser],
    ['client.headline', record.client.headline],
    ['client.plainEnglish', record.client.plainEnglish.join(' ')],
    ['client.analogy', record.client.analogy],
    ['client.benefits', record.client.benefits.join(' ')],
    ['client.steps', record.client.steps.join(' ')],
    ['client.clientCommitments', record.client.clientCommitments.join(' ')],
  ];
  for (const [path, text] of scan) {
    for (const hit of findBanned(text)) {
      errors.push({
        gate: 'prose',
        path,
        message: `banned word "${hit}" — describe the strategy with confidence, not hype`,
      });
    }
  }
  return errors;
}
