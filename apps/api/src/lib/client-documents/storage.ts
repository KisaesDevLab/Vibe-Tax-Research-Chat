// TP-3a — disk layout for client source documents (uploaded tax returns
// etc.). Mirrors lib/references/storage.ts: same ATTACHMENTS_DIR root (so
// DR backup coverage is automatic) under a dedicated `client-documents/`
// subtree. Raw PDF bytes live here; all TEXT derived from them is Shield-
// redacted before it is stored anywhere.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { dataDirs } from '../../config/paths.js';

export const CLIENT_DOCUMENTS_ROOT = path.join(dataDirs().attachments, 'client-documents');

export function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function clientDocumentStoragePath(documentId: string, filename: string): string {
  return path.join(CLIENT_DOCUMENTS_ROOT, documentId, sanitizeFilename(filename));
}

export async function writeClientDocumentBytes(
  documentId: string,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const dir = path.join(CLIENT_DOCUMENTS_ROOT, documentId);
  await fs.mkdir(dir, { recursive: true });
  const target = clientDocumentStoragePath(documentId, filename);
  await fs.writeFile(target, bytes);
  return target;
}

export async function readClientDocumentBytes(storagePath: string): Promise<Buffer> {
  return fs.readFile(storagePath);
}

export async function deleteClientDocumentFiles(documentId: string): Promise<void> {
  const dir = path.join(CLIENT_DOCUMENTS_ROOT, documentId);
  await fs.rm(dir, { recursive: true, force: true });
}
