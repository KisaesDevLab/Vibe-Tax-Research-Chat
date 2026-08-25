// TP-3a — client fact-pattern API. Mounted at /api/clients/:id/facts
// (mergeParams) behind requireAuth + requirePlanning in app.ts.
//
// Versioning contract: POST creates a new current version (optimistic
// concurrency via base_version; the partial unique index backstops races).
// Candidates: GET aggregates pending extraction candidates across the
// client's indexed documents; POST /candidates/resolve accepts/rejects them
// in one transaction — new version + candidate write-back + (optionally)
// the plan's `created` fact snapshot.
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@vibe/db';
import {
  client_documents,
  client_fact_patterns,
  plan_fact_snapshots,
  plans,
} from '@vibe/db/schema';
import type { DocumentCandidateDTO, FactCandidate } from '@vibe/shared';
import { validateFactPattern } from '@vibe/schema';
import { audit } from '../../lib/audit.js';
import {
  applyCandidates,
  computeConflicts,
  draftChangeSummary,
  type AcceptedCandidate,
} from '../../lib/facts/merge.js';
import {
  createFactPatternVersion,
  currentFactPattern,
  isUniqueViolation,
} from '../../lib/facts/versions.js';
import { findAttachableClient } from './index.js';
import { FROZEN_STATUSES } from '../planning/plans.js';

export const clientFactsRouter = Router({ mergeParams: true });

const uuidSchema = z.string().uuid();

function clientId(req: { params: Record<string, string | undefined> }): string {
  return req.params.id ?? '';
}

clientFactsRouter.get('/', async (req, res) => {
  const id = clientId(req);
  if (!uuidSchema.safeParse(id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const client = await findAttachableClient(id);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const row = await currentFactPattern(getDb(), id);
  res.json({ fact_pattern: row });
});

clientFactsRouter.get('/versions', async (req, res) => {
  const id = clientId(req);
  if (!uuidSchema.safeParse(id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const client = await findAttachableClient(id);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const rows = await getDb()
    .select({
      id: client_fact_patterns.id,
      version: client_fact_patterns.version,
      change_summary: client_fact_patterns.change_summary,
      created_by: client_fact_patterns.created_by,
      created_at: client_fact_patterns.created_at,
      superseded_at: client_fact_patterns.superseded_at,
    })
    .from(client_fact_patterns)
    .where(eq(client_fact_patterns.client_id, id))
    // created_at, not version: a client merge can leave duplicate numbers.
    .orderBy(desc(client_fact_patterns.created_at));
  res.json({ versions: rows });
});

clientFactsRouter.get('/versions/:versionId', async (req, res) => {
  const id = clientId(req);
  const versionId = req.params.versionId ?? '';
  if (!uuidSchema.safeParse(id).success || !uuidSchema.safeParse(versionId).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const [row] = await getDb()
    .select()
    .from(client_fact_patterns)
    .where(and(eq(client_fact_patterns.id, versionId), eq(client_fact_patterns.client_id, id)))
    .limit(1);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ fact_pattern: row });
});

const createSchema = z.object({
  facts: z.unknown(),
  change_summary: z.string().min(1).max(2000),
  base_version: z.number().int().min(0).optional(),
});

clientFactsRouter.post('/', async (req, res) => {
  const id = clientId(req);
  if (!uuidSchema.safeParse(id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const client = await findAttachableClient(id);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const validated = validateFactPattern(parsed.data.facts);
  if (!validated.ok) {
    res.status(400).json({ error: 'invalid_facts', detail: validated.errors });
    return;
  }
  const db = getDb();
  const current = await currentFactPattern(db, id);
  if (
    parsed.data.base_version !== undefined &&
    (current?.version ?? 0) !== parsed.data.base_version
  ) {
    res.status(409).json({ error: 'version_conflict', current_version: current?.version ?? 0 });
    return;
  }
  try {
    const row = await db.transaction(async (tx) =>
      createFactPatternVersion(tx, {
        clientId: id,
        facts: validated.facts,
        changeSummary: parsed.data.change_summary,
        createdBy: req.auth!.user_id,
      }),
    );
    await audit({
      actor_user_id: req.auth!.user_id,
      action: 'client.facts.update',
      target_type: 'client_fact_pattern',
      target_id: row.id,
      metadata: { client_id: id, version: row.version, change_summary: row.change_summary },
      ip: req.ip,
    });
    res.status(201).json({ fact_pattern: row });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'version_conflict' });
      return;
    }
    throw err;
  }
});

const restoreSchema = z.object({
  version_id: z.string().uuid(),
  change_summary: z.string().min(1).max(2000).optional(),
});

clientFactsRouter.post('/restore', async (req, res) => {
  const id = clientId(req);
  if (!uuidSchema.safeParse(id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const parsed = restoreSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const client = await findAttachableClient(id);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const db = getDb();
  const [source] = await db
    .select()
    .from(client_fact_patterns)
    .where(
      and(
        eq(client_fact_patterns.id, parsed.data.version_id),
        eq(client_fact_patterns.client_id, id),
      ),
    )
    .limit(1);
  if (!source) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  try {
    const row = await db.transaction(async (tx) =>
      createFactPatternVersion(tx, {
        clientId: id,
        facts: source.facts,
        changeSummary: parsed.data.change_summary ?? `Restored from version ${source.version}`,
        createdBy: req.auth!.user_id,
        schemaVersion: source.schema_version,
      }),
    );
    await audit({
      actor_user_id: req.auth!.user_id,
      action: 'client.facts.restore',
      target_type: 'client_fact_pattern',
      target_id: row.id,
      metadata: { client_id: id, version: row.version, restored_from_version: source.version },
      ip: req.ip,
    });
    res.status(201).json({ fact_pattern: row });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'version_conflict' });
      return;
    }
    throw err;
  }
});

async function pendingCandidates(clientIdValue: string): Promise<DocumentCandidateDTO[]> {
  const docs = await getDb()
    .select()
    .from(client_documents)
    .where(
      and(eq(client_documents.client_id, clientIdValue), eq(client_documents.status, 'indexed')),
    );
  const out: DocumentCandidateDTO[] = [];
  for (const doc of docs) {
    for (const candidate of doc.fact_candidates ?? []) {
      if (candidate.status !== 'pending') continue;
      out.push({
        document_id: doc.id,
        filename: doc.filename,
        doc_type: doc.doc_type,
        tax_year: doc.tax_year,
        candidate,
      });
    }
  }
  return out;
}

clientFactsRouter.get('/candidates', async (req, res) => {
  const id = clientId(req);
  if (!uuidSchema.safeParse(id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const client = await findAttachableClient(id);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const candidates = await pendingCandidates(id);
  res.json({ candidates, conflicts: computeConflicts(candidates) });
});

const resolveSchema = z.object({
  resolutions: z
    .array(
      z.object({
        document_id: z.string().uuid(),
        candidate_id: z.string().min(1),
        action: z.enum(['accept', 'reject']),
        edited_value: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(500),
  change_summary: z.string().min(1).max(2000).optional(),
  plan_id: z.string().uuid().optional(),
});

clientFactsRouter.post('/candidates/resolve', async (req, res) => {
  const id = clientId(req);
  if (!uuidSchema.safeParse(id).success) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid id' });
    return;
  }
  const parsed = resolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'bad_request', detail: parsed.error.flatten() });
    return;
  }
  const client = await findAttachableClient(id);
  if (!client) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const db = getDb();

  // Plan guard up front: the snapshot must attach to this client's
  // unfrozen plan or not at all.
  let plan: typeof plans.$inferSelect | null = null;
  if (parsed.data.plan_id) {
    const [p] = await db.select().from(plans).where(eq(plans.id, parsed.data.plan_id)).limit(1);
    if (!p || p.client_id !== id) {
      res.status(404).json({ error: 'not_found', detail: 'plan' });
      return;
    }
    if (FROZEN_STATUSES.includes(p.status)) {
      res.status(409).json({ error: 'plan_frozen' });
      return;
    }
    plan = p;
  }

  const docIds = [...new Set(parsed.data.resolutions.map((r) => r.document_id))];
  const docs = await db
    .select()
    .from(client_documents)
    .where(and(eq(client_documents.client_id, id), inArray(client_documents.id, docIds)));
  const docById = new Map(docs.map((d) => [d.id, d]));

  const accepted: AcceptedCandidate[] = [];
  const now = new Date().toISOString();
  const updatedCandidates = new Map<string, FactCandidate[]>();
  for (const resolution of parsed.data.resolutions) {
    const doc = docById.get(resolution.document_id);
    if (!doc) {
      res.status(404).json({ error: 'not_found', detail: `document ${resolution.document_id}` });
      return;
    }
    const list = updatedCandidates.get(doc.id) ?? structuredClone(doc.fact_candidates ?? []);
    const candidate = list.find((c) => c.id === resolution.candidate_id);
    if (!candidate) {
      res.status(404).json({ error: 'not_found', detail: `candidate ${resolution.candidate_id}` });
      return;
    }
    if (candidate.status !== 'pending') {
      res.status(409).json({ error: 'candidate_already_resolved', candidate_id: candidate.id });
      return;
    }
    candidate.status = resolution.action === 'accept' ? 'accepted' : 'rejected';
    candidate.resolvedBy = req.auth!.user_id;
    candidate.resolvedAt = now;
    if (resolution.action === 'accept') {
      if (resolution.edited_value !== undefined) candidate.editedValue = resolution.edited_value;
      accepted.push({ candidate, value: resolution.edited_value ?? candidate.value });
    }
    updatedCandidates.set(doc.id, list);
  }

  const current = await currentFactPattern(db, id);

  // Reject-only resolutions don't create a version — just mark candidates.
  if (accepted.length === 0) {
    await db.transaction(async (tx) => {
      for (const [docId, list] of updatedCandidates) {
        await tx
          .update(client_documents)
          .set({ fact_candidates: list })
          .where(eq(client_documents.id, docId));
      }
    });
    await audit({
      actor_user_id: req.auth!.user_id,
      action: 'client.facts.accept_candidates',
      target_type: 'client',
      target_id: id,
      metadata: { client_id: id, accepted: 0, rejected: parsed.data.resolutions.length },
      ip: req.ip,
    });
    res.json({ fact_pattern: current, snapshot: null });
    return;
  }

  const mergedFacts = applyCandidates(current?.facts ?? null, accepted);
  const validated = validateFactPattern(mergedFacts);
  if (!validated.ok) {
    res.status(400).json({ error: 'invalid_facts', detail: validated.errors });
    return;
  }
  const changeSummary =
    parsed.data.change_summary ??
    draftChangeSummary(
      accepted,
      docs.map((d) => ({ id: d.id, filename: d.filename })),
    );

  try {
    const result = await db.transaction(async (tx) => {
      const version = await createFactPatternVersion(tx, {
        clientId: id,
        facts: validated.facts,
        changeSummary,
        createdBy: req.auth!.user_id,
      });
      for (const [docId, list] of updatedCandidates) {
        for (const c of list) {
          if (c.resolvedAt === now && c.status === 'accepted') {
            c.resolvedFactPatternId = version.id;
          }
        }
        await tx
          .update(client_documents)
          .set({ fact_candidates: list })
          .where(eq(client_documents.id, docId));
      }
      let snapshot = null;
      if (plan) {
        const [snap] = await tx
          .insert(plan_fact_snapshots)
          .values({
            plan_id: plan.id,
            fact_pattern_id: version.id,
            fact_pattern_version: version.version,
            snapshot_kind: 'created',
            facts: version.facts,
          })
          .onConflictDoUpdate({
            target: [plan_fact_snapshots.plan_id, plan_fact_snapshots.snapshot_kind],
            set: {
              fact_pattern_id: version.id,
              fact_pattern_version: version.version,
              facts: version.facts,
              snapshot_at: new Date(),
            },
          })
          .returning();
        snapshot = snap ?? null;
      }
      return { version, snapshot };
    });
    await audit({
      actor_user_id: req.auth!.user_id,
      action: 'client.facts.accept_candidates',
      target_type: 'client_fact_pattern',
      target_id: result.version.id,
      metadata: {
        client_id: id,
        plan_id: plan?.id ?? null,
        version: result.version.version,
        accepted: accepted.length,
        rejected: parsed.data.resolutions.length - accepted.length,
        change_summary: changeSummary,
      },
      ip: req.ip,
    });
    res.json({ fact_pattern: result.version, snapshot: result.snapshot });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'version_conflict' });
      return;
    }
    throw err;
  }
});
