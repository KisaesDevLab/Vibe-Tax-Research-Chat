// Phase 23 — chat attachments. Accepts PDF, DOCX, TXT, MD, HTML, image.
import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import { chats, chat_attachments } from '@vibe/db/schema';
import { requireAuth } from '../../middleware/auth.js';
import { parseAttachment } from '../../lib/parsers/index.js';
import { attachmentSummarizeQueue } from '../../jobs/queues.js';
import { logger } from '../../lib/logger.js';

export const attachmentsRouter = Router({ mergeParams: true });
attachmentsRouter.use(requireAuth);

const STORAGE_ROOT = path.resolve(process.env.ATTACHMENTS_DIR ?? './attachments');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const uuidSchema = z.string().uuid();

// Owner-or-admin chat lookup. Mirrors the pattern used in chats/index.ts —
// a user only sees their own chats; admins can act on any chat. Returns
// null when the chat doesn't exist OR the caller can't see it (the two
// are deliberately indistinguishable from the client's perspective).
async function chatVisibleToCaller(
  chatId: string,
  userId: string,
  isAdmin: boolean,
): Promise<{ id: string; user_id: string } | null> {
  const where = isAdmin
    ? eq(chats.id, chatId)
    : and(eq(chats.id, chatId), eq(chats.user_id, userId));
  const [row] = await getDb()
    .select({ id: chats.id, user_id: chats.user_id })
    .from(chats)
    .where(where)
    .limit(1);
  return row ?? null;
}

attachmentsRouter.post('/', upload.single('file'), async (req, res) => {
  const chatId = (req.params as unknown as { id: string }).id;
  if (!uuidSchema.safeParse(chatId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'no_file' });
    return;
  }
  const isAdmin = req.auth!.role === 'admin';
  const chat = await chatVisibleToCaller(chatId, req.auth!.user_id, isAdmin);
  if (!chat) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Persist bytes
  await fs.mkdir(path.join(STORAGE_ROOT, chatId), { recursive: true });
  const stamp = Date.now();
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = path.join(STORAGE_ROOT, chatId, `${stamp}_${safeName}`);
  await fs.writeFile(storagePath, req.file.buffer);

  // Parse
  const parsed = await parseAttachment({
    buffer: req.file.buffer,
    mime_type: req.file.mimetype,
    filename: req.file.originalname,
  });

  const inserted = await getDb()
    .insert(chat_attachments)
    .values({
      chat_id: chatId,
      uploaded_by: req.auth!.user_id,
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      storage_path: storagePath,
      full_text: parsed.full_text,
      ocr_applied: parsed.ocr_applied,
    })
    .returning({ id: chat_attachments.id, created_at: chat_attachments.created_at });

  // Async summary
  await attachmentSummarizeQueue.add('summarize', { attachment_id: inserted[0]!.id });

  res.status(201).json({
    attachment: {
      id: inserted[0]!.id,
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      ocr_applied: parsed.ocr_applied,
      created_at: inserted[0]!.created_at,
    },
  });
});

attachmentsRouter.get('/', async (req, res) => {
  const chatId = (req.params as unknown as { id: string }).id;
  if (!uuidSchema.safeParse(chatId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const isAdmin = req.auth!.role === 'admin';
  const chat = await chatVisibleToCaller(chatId, req.auth!.user_id, isAdmin);
  if (!chat) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const rows = await getDb()
    .select({
      id: chat_attachments.id,
      filename: chat_attachments.filename,
      mime_type: chat_attachments.mime_type,
      size_bytes: chat_attachments.size_bytes,
      summary: chat_attachments.summary,
      ocr_applied: chat_attachments.ocr_applied,
      created_at: chat_attachments.created_at,
    })
    .from(chat_attachments)
    .where(eq(chat_attachments.chat_id, chatId));
  res.json({ attachments: rows });
});

attachmentsRouter.delete('/:attachment_id', async (req, res) => {
  const chatId = (req.params as unknown as { id: string }).id;
  const attachmentId = req.params.attachment_id;
  if (!uuidSchema.safeParse(chatId).success || !uuidSchema.safeParse(attachmentId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const isAdmin = req.auth!.role === 'admin';
  const chat = await chatVisibleToCaller(chatId, req.auth!.user_id, isAdmin);
  if (!chat) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const db = getDb();
  const [row] = await db
    .select({ id: chat_attachments.id, storage_path: chat_attachments.storage_path })
    .from(chat_attachments)
    .where(and(eq(chat_attachments.id, attachmentId), eq(chat_attachments.chat_id, chatId)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await db.delete(chat_attachments).where(eq(chat_attachments.id, row.id));
  // Best-effort: unlink the underlying file. If the file was already gone
  // (manual cleanup, restored from a backup that didn't include the
  // sidecar tarball, etc.) we still want the row to be deleted so the
  // chat doesn't retain a phantom attachment.
  try {
    await fs.unlink(row.storage_path);
  } catch (err) {
    logger.warn(
      { err, attachment_id: row.id },
      'attachment file unlink failed (row still removed)',
    );
  }
  res.status(204).end();
});
