// Phase 34 — placeholder tool implementations.
//
// usc_lookup and cfr_lookup are real (BUILD_PLAN §34's two highest-value
// sources). The remaining five tools have their schemas pinned and
// throw a typed `not_implemented` error so the chat-side strategy
// router (Phase 36, separate PR) can fall through to Anthropic web_fetch
// for those sources without crashing.
//
// Each stub still routes through the cache layer so a future real
// implementation can be dropped in without touching the dispatcher.
import { z } from 'zod';

export const fr_searchInput = z.object({
  agency: z.string().default('IRS'),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  query: z.string().min(1),
});

export const dawson_searchInput = z.object({
  query: z.string().min(1),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const irb_lookupInput = z.object({
  // e.g. "Rev. Rul. 2024-12" or "Notice 2023-7"
  item: z.string().min(1),
});

export const pl_lookupInput = z.object({
  // e.g. "117-169" (Inflation Reduction Act)
  public_law: z.string().regex(/^\d+-\d+$/, 'expected NNN-NN format'),
});

export const state_dor_searchInput = z.object({
  state: z.string().regex(/^[a-z]{2}$/, 'two-letter lowercase state code'),
  query: z.string().min(1),
});

export class NotImplementedError extends Error {
  readonly code = 'not_implemented';
  constructor(public readonly tool: string) {
    super(
      `${tool} is not implemented in this build. Phase 34 ships usc_lookup ` +
        `and cfr_lookup; the rest follow in the next iteration.`,
    );
    this.name = 'NotImplementedError';
  }
}

export async function frSearch(): Promise<never> {
  throw new NotImplementedError('fr_search');
}
export async function dawsonSearch(): Promise<never> {
  throw new NotImplementedError('dawson_search');
}
export async function irbLookup(): Promise<never> {
  throw new NotImplementedError('irb_lookup');
}
export async function plLookup(): Promise<never> {
  throw new NotImplementedError('pl_lookup');
}
export async function stateDorSearch(): Promise<never> {
  throw new NotImplementedError('state_dor_search');
}
