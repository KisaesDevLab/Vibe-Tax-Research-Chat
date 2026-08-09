// DR v2 — TOC filtering and helper parsing. The filter operates on
// pg_restore -l output (TOC entries), never on SQL text: a data row whose
// content resembles "CREATE EXTENSION" can no longer be corrupted by a
// regex, which was a structural risk of the v1 SQL-stream filter.
import { describe, expect, it } from 'vitest';
import { filterToc, parseToolMajor, dbUrlFor, maintenanceUrl, databaseUrl } from './pg.js';

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
  it('drops EXTENSION and COMMENT-EXTENSION entries, keeps everything else', () => {
    const skipped: string[] = [];
    const { filtered, kept } = filterToc(TOC, (l) => skipped.push(l));
    expect(skipped).toEqual([
      '16; 3079 2 EXTENSION - vector',
      '17; 0 0 COMMENT - EXTENSION vector',
    ]);
    expect(filtered).not.toMatch(/EXTENSION/);
    expect(filtered).toContain('TABLE DATA public users');
    expect(filtered).toContain('CONSTRAINT users users_pkey');
    // Comment lines pass through untouched — pg_restore needs the header.
    expect(filtered).toContain('; Selected TOC Entries:');
    expect(kept).toBe(7);
  });

  it('does not misread a COMMENT on a table as an extension comment', () => {
    const toc = `18; 0 0 COMMENT - TABLE users vibe\n`;
    const { filtered } = filterToc(toc);
    expect(filtered).toContain('COMMENT - TABLE users');
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
