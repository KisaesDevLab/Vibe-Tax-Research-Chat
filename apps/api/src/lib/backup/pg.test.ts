// DR v2 — TOC filtering and helper parsing. The filter operates on
// pg_restore -l output (TOC entries), never on SQL text: a data row whose
// content resembles "CREATE EXTENSION" can no longer be corrupted by a
// regex, which was a structural risk of the v1 SQL-stream filter.
import { describe, expect, it } from 'vitest';
import {
  filterToc,
  parseToolMajor,
  dbUrlFor,
  maintenanceUrl,
  databaseUrl,
  pgDumpArgs,
} from './pg.js';

// Trimmed from a real `pg_restore -l` listing of a pgvector database.
const TOC = `;
; Archive created at 2026-08-09 14:00:00 UTC
;     dbname: vibe_tax
;     Format: CUSTOM
;
; Selected TOC Entries:
;
16; 3079 2 EXTENSION - vector
17; 0 0 COMMENT - EXTENSION vector
5; 2615 2200 SCHEMA - public vibe
215; 1259 16403 TABLE public users vibe
216; 1259 16412 TABLE public chats vibe
3502; 0 16403 TABLE DATA public users vibe
3503; 0 16412 TABLE DATA public chats vibe
2716; 2606 16425 CONSTRAINT users users_pkey vibe
217; 1259 16500 INDEX public messages_chat_id_idx vibe
`;

describe('filterToc', () => {
  it('drops EXTENSION, COMMENT-EXTENSION, and public-SCHEMA entries, keeps everything else', () => {
    const skipped: string[] = [];
    const { filtered, kept } = filterToc(TOC, (l) => skipped.push(l));
    expect(skipped).toEqual([
      '16; 3079 2 EXTENSION - vector',
      '17; 0 0 COMMENT - EXTENSION vector',
      // Scratch databases already have public; recreating it is fatal
      // under --exit-on-error.
      '5; 2615 2200 SCHEMA - public vibe',
    ]);
    expect(filtered).not.toMatch(/EXTENSION/);
    expect(filtered).toContain('TABLE DATA public users');
    expect(filtered).toContain('CONSTRAINT users users_pkey');
    // Comment lines pass through untouched — pg_restore needs the header.
    expect(filtered).toContain('; Selected TOC Entries:');
    expect(kept).toBe(6);
  });

  it('drops the public schema COMMENT but keeps non-public schemas', () => {
    const toc = [
      '6; 0 0 COMMENT - SCHEMA public postgres',
      '7; 2615 2300 SCHEMA - drizzle vibe',
    ].join('\n');
    const { filtered } = filterToc(toc);
    expect(filtered).not.toContain('SCHEMA public');
    expect(filtered).toContain('SCHEMA - drizzle');
  });

  it('does not misread a COMMENT on a table as an extension comment', () => {
    const toc = `18; 0 0 COMMENT - TABLE users vibe\n`;
    const { filtered } = filterToc(toc);
    expect(filtered).toContain('COMMENT - TABLE users');
  });
});

describe('pgDumpArgs', () => {
  it('allowlists the app schemas so extension schemas (tiger etc.) are never walked', () => {
    const args = pgDumpArgs({
      url: 'postgres://u:p@h:5439/vibe_tax',
      snapshotId: '00000003-1',
      outFile: '/tmp/db.dump',
    });
    // Unscoped dumps COPY extension config tables (tiger.geocode_settings)
    // the app role cannot read — the dump must name its schemas.
    expect(args.join(' ')).toContain('-n public');
    expect(args.join(' ')).toContain('-n drizzle');
    expect(args).toContain('--snapshot=00000003-1');
    expect(args).toContain('-Fc');
    // Windows argv lesson: the URL rides behind -d, never positional-first.
    expect(args[args.indexOf('-d') + 1]).toBe('postgres://u:p@h:5439/vibe_tax');
  });
});

describe('url + version helpers', () => {
  it('parses tool majors', () => {
    expect(parseToolMajor('pg_dump (PostgreSQL) 16.11')).toBe(16);
    expect(parseToolMajor('pg_restore (PostgreSQL) 17.2')).toBe(17);
    expect(parseToolMajor('gibberish')).toBeNull();
  });

  it('derives sibling database urls from DATABASE_URL', () => {
    // env is cached at module load, so assert relative to whatever URL the
    // process actually has: only the pathname may change.
    const base = new URL(databaseUrl());
    const scratch = new URL(dbUrlFor('vibe_tax_restore_x'));
    expect(scratch.pathname).toBe('/vibe_tax_restore_x');
    expect(scratch.host).toBe(base.host);
    expect(scratch.username).toBe(base.username);
    const maint = new URL(maintenanceUrl());
    expect(maint.pathname).toBe('/postgres');
    expect(maint.host).toBe(base.host);
  });
});
