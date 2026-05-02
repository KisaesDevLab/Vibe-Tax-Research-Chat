// Phase 32 — embeddings provider interface.
//
// Embedding clients return one float vector per input string. All
// providers normalize to 1024-dim so the downstream HNSW index in
// reference_chunks (vector(1024)) doesn't have to care which provider
// produced the row. If a future provider ships at a different dim, we'll
// version the column and the routing layer; not v1.5.

export type EmbeddingVector = number[];

export interface EmbeddingResult {
  vectors: EmbeddingVector[];
  // Total billable tokens reported by the provider, summed across the
  // input batch. Surfaced in the admin Reference Library so firms can see
  // the embedding cost trail.
  inputTokens: number;
  // Echoed back from the provider — useful for storing alongside chunks
  // so a later embedding-model upgrade knows what to re-embed.
  model: string;
}

export interface EmbeddingsClient {
  /** The model name this client is configured for. */
  readonly model: string;
  /** Vector dimension produced by this client. */
  readonly dimensions: number;
  /**
   * Embed an array of input strings. Caller is responsible for chunking
   * to fit the provider's per-request token budget; the client batches
   * within a single request only.
   *
   * `inputType` lets the provider differentiate document-side vs
   * query-side embeddings when the model supports it (Voyage does, BGE
   * does not — the parameter is silently ignored where not relevant).
   */
  embed(inputs: string[], inputType: 'document' | 'query'): Promise<EmbeddingResult>;
}
