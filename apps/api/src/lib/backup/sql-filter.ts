// Strip statements a non-superuser cannot execute from a pg_dump stream.
//
// pg_dump --clean emits extension management around the schema:
//
//   DROP EXTENSION IF EXISTS vector;
//   CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
//   COMMENT ON EXTENSION vector IS '…';
//
// Creating an untrusted extension requires superuser. That is fine on a
// bundled Postgres where the app owns the server, but an appliance points
// the app at a SHARED database with a scoped role, and there the restore
// dies at that line:
//
//   ERROR: permission denied to create extension "vector"
//   HINT:  Must be superuser to create this extension.
//
// The extension is infrastructure rather than app data — the destination
// must already have it or the app could not run at all — so dropping these
// statements is what makes a backup portable between servers. The restore
// still attempts CREATE EXTENSION separately on a best-effort basis.
import { Transform } from 'node:stream';

const SKIP = [
  /^\s*DROP\s+EXTENSION\b/i,
  /^\s*CREATE\s+EXTENSION\b/i,
  /^\s*COMMENT\s+ON\s+EXTENSION\b/i,
  // pg_dump 17 opens every dump with `SET transaction_timeout = 0;`, a GUC
  // that does not exist before PostgreSQL 17, so a 17-authored archive
  // cannot be loaded into 16 at all:
  //
  //   ERROR: unrecognized configuration parameter "transaction_timeout"
  //
  // Matching the client to the server prevents this for archives THIS
  // version writes, but a backup is a portable artifact — it may have been
  // written by another install, an older build, or a newer server than the
  // one restoring it. The value pg_dump emits is the parameter's own
  // default, so dropping the line changes nothing about the restore.
  /^\s*SET\s+transaction_timeout\b/i,
  // pg_dump also writes `SET lock_timeout = 0;` into the header, which
  // silently undoes whatever lock_timeout the restore set on the
  // connection. With it in place a DROP blocked by another session waits
  // forever: no error, no psql exit, no timeout — the restore simply hangs.
  // Dropping the line lets the caller's bound survive. statement_timeout is
  // deliberately NOT stripped; a large restore is legitimately slow.
  /^\s*SET\s+lock_timeout\b/i,
];

/**
 * Line-filter the dump, leaving COPY payloads untouched.
 *
 * COPY data is not SQL and must never be pattern-matched: a row whose text
 * happens to begin with "CREATE EXTENSION" would otherwise be silently
 * dropped, corrupting the restore in a way no error would reveal. Track the
 * COPY … FROM stdin block (terminated by a lone `\.`) and pass it verbatim.
 */
export function stripSuperuserOnly(onSkip?: (line: string) => void): Transform {
  let buf = '';
  let inCopy = false;

  const handle = (line: string): string | null => {
    if (inCopy) {
      if (line === '\\.') inCopy = false;
      return line;
    }
    if (/^\s*COPY\s.+\sFROM\s+stdin;/i.test(line)) {
      inCopy = true;
      return line;
    }
    if (SKIP.some((re) => re.test(line))) {
      onSkip?.(line.trim());
      return null;
    }
    return line;
  };

  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString('utf-8');
      const lines = buf.split('\n');
      // The last element may be a partial line; keep it for the next chunk.
      buf = lines.pop() ?? '';
      const out: string[] = [];
      for (const line of lines) {
        const kept = handle(line);
        if (kept !== null) out.push(kept);
      }
      cb(null, out.length ? `${out.join('\n')}\n` : '');
    },
    flush(cb) {
      if (buf.length === 0) return cb();
      const kept = handle(buf);
      cb(null, kept === null ? '' : kept);
    },
  });
}
