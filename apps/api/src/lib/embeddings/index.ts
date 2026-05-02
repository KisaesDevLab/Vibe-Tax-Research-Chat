// Phase 32 — embeddings provider selector. Reads EMBEDDINGS_PROVIDER /
// EMBEDDINGS_MODEL / EMBEDDINGS_API_KEY from env and returns a singleton
// client. Anyone embedding text — the ingest worker, the per-turn query
// retrieval — goes through getEmbeddingsClient().
import type { EmbeddingsClient } from './types.js';
import { VoyageEmbeddingsClient } from './voyage.js';
import { env } from '../../config/env.js';

let cached: EmbeddingsClient | undefined;

export function getEmbeddingsClient(): EmbeddingsClient {
  if (cached) return cached;
  switch (env.EMBEDDINGS_PROVIDER) {
    case 'voyage': {
      if (!env.EMBEDDINGS_API_KEY) {
        throw new Error(
          'EMBEDDINGS_API_KEY is required when EMBEDDINGS_PROVIDER=voyage. ' +
            'Issue one at https://dash.voyageai.com/ and set it in .env (or, ' +
            'in appliance mode, in the appliance bootstrapper).',
        );
      }
      cached = new VoyageEmbeddingsClient(env.EMBEDDINGS_API_KEY, env.EMBEDDINGS_MODEL);
      return cached;
    }
    case 'anthropic':
      // Reserved for when Anthropic ships first-party embeddings. Until
      // then, fail fast rather than silently embedding with a stub.
      throw new Error(
        'EMBEDDINGS_PROVIDER=anthropic is reserved — Anthropic does not yet ' +
          'offer a first-party embeddings API. Use voyage for now.',
      );
    default:
      // Exhaustiveness check — z.enum on env keeps this from firing in
      // practice, but it pins future contributors to update both places.
      throw new Error(`Unknown EMBEDDINGS_PROVIDER: ${env.EMBEDDINGS_PROVIDER as string}`);
  }
}

// Test helper — not part of the public surface. Lets test files inject
// a fake client without standing up the env-var dance.
export function _setEmbeddingsClientForTesting(client: EmbeddingsClient | undefined): void {
  cached = client;
}

export type { EmbeddingsClient, EmbeddingResult, EmbeddingVector } from './types.js';
