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

export const attachmentsRouter = Router({ mergeParams: true });
attachmentsRouter.use(requireAuth);

const STORAGE_ROOT = path.resolve(process.env.ATTACHMENTS_DIR ?? './attachments');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

attachmentsRouter.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no_file' });
    return;
  }
  const chatId = (req.params as unknown as { id: string }).id;
  const db = getDb();
  const [chat] = await db
    .select()
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.user_id, req.auth!.user_id)))
    .limit(1);
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

  const inserted = await db
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
    .returning({ id: chat_attachments.id });

  // Async summary
  await attachmentSummarizeQueue.add('summarize', { attachment_id: inserted[0]!.id });

  res.status(201).json({
    attachment: {
      id: inserted[0]!.id,
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
      ocr_applied: parsed.ocr_applied,
    },
  });
});

const listSchema = z.object({});

attachmentsRouter.get('/', async (req, res) => {
  void listSchema;
  const chatId = (req.params as unknown as { id: string }).id;
  const rows = await getDb()
    .select({
      id: chat_attachments.id,
      filename: chat_attachments.filename,
      mime_type: chat_attachments.mime_type,
      size_bytes: chat_attachments.size_bytes,
      summary: chat_attachments.summary,
      created_at: chat_attachments.created_at,
    })
    .from(chat_attachments)
    .where(eq(chat_attachments.chat_id, chatId));
  res.json({ attachments: rows });
});
