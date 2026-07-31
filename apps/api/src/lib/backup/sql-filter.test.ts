// The filter runs over every byte of every restore, so it has to be exact:
// dropping one statement too many corrupts the restore silently, and
// pattern-matching inside COPY payloads would corrupt the DATA silently —
// which is worse, because nothing errors.
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { stripSuperuserOnly } from './sql-filter.js';

async function run(sql: string): Promise<{ out: string; skipped: string[] }> {
  const skipped: string[] = [];
  const chunks: Buffer[] = [];
  const stream = Readable.from([Buffer.from(sql)]).pipe(stripSuperuserOnly((l) => skipped.push(l)));
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return { out: Buffer.concat(chunks).toString('utf-8'), skipped };
}

describe('stripSuperuserOnly', () => {
  it('removes extension management statements', async () => {
    const { out, skipped } = await run(
      [
        'DROP EXTENSION IF EXISTS vector;',
        'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;',
        "COMMENT ON EXTENSION vector IS 'vector data type';",
        'CREATE TABLE t (id int);',
      ].join('\n'),
    );
    expect(out).not.toMatch(/EXTENSION/);
    expect(out).toContain('CREATE TABLE t (id int);');
    expect(skipped).toHaveLength(3);
  });

  it('removes a PG17-only SET so a 17 dump loads into 16', async () => {
    const { out, skipped } = await run(
      ['SET statement_timeout = 0;', 'SET transaction_timeout = 0;', 'SELECT 1;'].join('\n'),
    );
    expect(out).toContain('SET statement_timeout = 0;');
    expect(out).not.toMatch(/transaction_timeout/);
    expect(skipped).toEqual(['SET transaction_timeout = 0;']);
  });

  it('keeps every other statement byte-for-byte', async () => {
    const sql = [
      'SET statement_timeout = 0;',
      'CREATE SCHEMA drizzle;',
      'CREATE TABLE plans (id uuid PRIMARY KEY);',
      "INSERT INTO plans VALUES ('x');",
      '',
    ].join('\n');
    const { out, skipped } = await run(sql);
    expect(out).toBe(sql);
    expect(skipped).toEqual([]);
  });

  it('never filters inside a COPY payload', async () => {
    // A row whose text begins with CREATE EXTENSION must survive: it is
    // data, not SQL.
    const sql = [
      'COPY public.notes (id, body) FROM stdin;',
      '1\tCREATE EXTENSION IF NOT EXISTS vector;',
      '2\tDROP EXTENSION vector;',
      '\\.',
      'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;',
      '',
    ].join('\n');
    const { out, skipped } = await run(sql);
    expect(out).toContain('1\tCREATE EXTENSION IF NOT EXISTS vector;');
    expect(out).toContain('2\tDROP EXTENSION vector;');
    // Only the real statement after the COPY block is dropped.
    expect(skipped).toEqual(['CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;']);
  });

  it('handles statements split across chunk boundaries', async () => {
    const skipped: string[] = [];
    const chunks: Buffer[] = [];
    // Deliberately split mid-statement to exercise the partial-line buffer.
    const parts = [
      'CREATE TABLE a (id int);\nCREATE EXTE',
      'NSION IF NOT EXISTS vector;\nSELECT 1;',
    ];
    const stream = Readable.from(parts.map((p) => Buffer.from(p))).pipe(
      stripSuperuserOnly((l) => skipped.push(l)),
    );
    for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
    const out = Buffer.concat(chunks).toString('utf-8');
    expect(out).toContain('CREATE TABLE a (id int);');
    expect(out).toContain('SELECT 1;');
    expect(out).not.toMatch(/EXTENSION/);
    expect(skipped).toHaveLength(1);
  });

  it('passes an empty stream through', async () => {
    const { out, skipped } = await run('');
    expect(out).toBe('');
    expect(skipped).toEqual([]);
  });
});
