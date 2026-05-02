// One-shot smoke test: drive an actual drizzle insert with a JS number[]
// embedding, verify the value round-trips through the pgvector extension,
// and that a cosine-similarity query orders by distance correctly.
//
// Run via: DATABASE_URL=postgres://… tsx src/scripts/drizzle-vector-roundtrip.ts
//
// This file is excluded from the build output (script, not library code)
// — kept under packages/db so it shares the schema imports.
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { getDb, closeDb, schema } from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
loadEnv({ path: path.resolve(__dirname, '../../../../.env') });

// Guard so a stray `import './scripts/drizzle-vector-roundtrip.js'`
// never executes the smoke test as a side effect — tsc otherwise
// happily compiles this file into dist/ alongside library code.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

async function main(): Promise<void> {
  const db = getDb();

  // Make a deterministic 1024-dim vector. Two distinct shapes so we can
  // sanity-check ordering: vec1 = all 0.1, vec2 = mostly 0.1 but with
  // one zero — should rank slightly less similar to a vec1 query.
  const vec1: number[] = new Array(1024).fill(0.1);
  const vec2: number[] = new Array(1024).fill(0.1);
  vec2[0] = 0;

  const docId = '22222222-2222-2222-2222-222222222222';
  const chunkId1 = '33333333-3333-3333-3333-333333333331';
  const chunkId2 = '33333333-3333-3333-3333-333333333332';

  // Clean any prior run so the script is re-runnable.
  await db
    .delete(schema.reference_chunks)
    .where(sql`${schema.reference_chunks.id} IN (${chunkId1}, ${chunkId2})`);
  await db
    .delete(schema.reference_documents)
    .where(sql`${schema.reference_documents.id} = ${docId}`);

  await db.insert(schema.reference_documents).values({
    id: docId,
    title: 'Drizzle round-trip test',
    source: 'upload',
    status: 'indexed',
    tags: [],
  });

  await db.insert(schema.reference_chunks).values([
    {
      id: chunkId1,
      document_id: docId,
      chunk_index: 0,
      text: 'identical to query',
      embedding: vec1,
      char_start: 0,
      char_end: 18,
    },
    {
      id: chunkId2,
      document_id: docId,
      chunk_index: 1,
      text: 'slightly off',
      embedding: vec2,
      char_start: 19,
      char_end: 31,
    },
  ]);

  // Cosine query against vec1 — chunk_id1 must come back first with
  // similarity ~1.0. chunk_id2 should be very close but slightly less.
  const queryVec = `[${vec1.join(',')}]`;
  type Row = { chunk_id: string; text: string; similarity: number };
  const rows = (await db.execute(sql`
    SELECT id AS chunk_id, text,
           1 - (embedding <=> ${queryVec}::vector) AS similarity
    FROM reference_chunks
    WHERE document_id = ${docId}
    ORDER BY embedding <=> ${queryVec}::vector
    LIMIT 5
  `)) as unknown as Row[];

  console.log(JSON.stringify(rows, null, 2));

  if (rows.length !== 2) {
    throw new Error(`expected 2 rows, got ${rows.length}`);
  }
  if (rows[0]!.chunk_id !== chunkId1) {
    throw new Error(`expected chunk_id1 first, got ${rows[0]!.chunk_id}`);
  }
  if (Math.abs(rows[0]!.similarity - 1.0) > 0.001) {
    throw new Error(`expected similarity ~1.0, got ${rows[0]!.similarity}`);
  }
  if (!(rows[1]!.similarity < rows[0]!.similarity)) {
    throw new Error('expected ranking by descending similarity');
  }

  console.log('drizzle vector round-trip OK');
  await closeDb();
}

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
