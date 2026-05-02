// Phase 32 — Voyage AI embeddings client.
//
// Wraps POST https://api.voyageai.com/v1/embeddings. voyage-3-large is the
// default: 1024 dim, cosine, $0.18/1M tokens at time of writing — cheap
// enough that re-embedding the firm corpus on a model upgrade is a
// one-time line item, not a budget concern.
import type { EmbeddingsClient, EmbeddingResult } from './types.js';
import { logger } from '../logger.js';

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

// Built-in dimensions per model. New models can be added without code
// changes; if a customer points us at a not-listed model we default to
// 1024 (the column type) and let the provider error if it disagrees.
const KNOWN_DIMENSIONS: Record<string, number> = {
  'voyage-3-large': 1024,
  'voyage-3': 1024,
  'voyage-3-lite': 512,
  'voyage-code-3': 1024,
  'voyage-finance-2': 1024,
  'voyage-law-2': 1024,
};

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { total_tokens: number };
}

export class VoyageEmbeddingsClient implements EmbeddingsClient {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;

  constructor(apiKey: string, model = 'voyage-3-large') {
    if (!apiKey) {
      throw new Error('VoyageEmbeddingsClient: EMBEDDINGS_API_KEY is required');
    }
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = KNOWN_DIMENSIONS[model] ?? 1024;
  }

  async embed(inputs: string[], inputType: 'document' | 'query'): Promise<EmbeddingResult> {
    if (inputs.length === 0) {
      return { vectors: [], inputTokens: 0, model: this.model };
    }
    const body = {
      input: inputs,
      model: this.model,
      input_type: inputType,
      // float (default) is what we want — pgvector ingests JS number[]
      // arrays directly.
      output_dimension: this.dimensions,
    };
    const res = await fetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 401/403 means a bad EMBEDDINGS_API_KEY; surface it loudly so the
      // admin can fix the env var rather than chase a queue full of
      // failed jobs.
      logger.error(
        { status: res.status, body: text.slice(0, 500), model: this.model },
        'voyage embeddings request failed',
      );
      throw new Error(`Voyage embeddings ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as VoyageResponse;
    // Voyage returns results in the order of `index`. Sort to be safe —
    // the spec doesn't require ordered, and we depend on index alignment
    // when bulk-inserting chunks.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return {
      vectors: sorted.map((d) => d.embedding),
      inputTokens: json.usage?.total_tokens ?? 0,
      model: json.model ?? this.model,
    };
  }
}
