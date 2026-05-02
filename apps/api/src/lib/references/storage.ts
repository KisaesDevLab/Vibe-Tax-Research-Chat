// Phase 32 — disk layout for firm-uploaded reference documents.
//
// Reuses the existing ATTACHMENTS_DIR (already mounted at /app/attachments
// in prod compose) but under a dedicated `references/` subtree so the
// chat-attachment and reference-library namespaces don't collide. Skip-
// backup of attachments would also skip references — that's the right
// behavior, since references are firm-private and need backup coverage.
import path from 'node:path';
import { promises as fs } from 'node:fs';

export const REFERENCES_ROOT = path.resolve(
  process.env.ATTACHMENTS_DIR ?? './attachments',
  'references',
);

export function referenceStoragePath(documentId: string, filename: string): string {
  // documentId is a uuid — safe as a directory name. Sanitize the filename
  // to prevent traversal characters; we keep the original name solely so
  // the admin UI can show a familiar label on disk.
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(REFERENCES_ROOT, documentId, safeName);
}

export async function writeReferenceBytes(
  documentId: string,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const dir = path.join(REFERENCES_ROOT, documentId);
  await fs.mkdir(dir, { recursive: true });
  const target = referenceStoragePath(documentId, filename);
  await fs.writeFile(target, bytes);
  return target;
}

export async function readReferenceBytes(storagePath: string): Promise<Buffer> {
  return fs.readFile(storagePath);
}

export async function deleteReferenceFiles(documentId: string): Promise<void> {
  const dir = path.join(REFERENCES_ROOT, documentId);
  await fs.rm(dir, { recursive: true, force: true });
}
