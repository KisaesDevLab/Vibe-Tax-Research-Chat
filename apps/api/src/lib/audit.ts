// Phase 3 — audit log writer. Mandatory for every admin action.
import { getDb } from '@vibe/db';
import { audit_log } from '@vibe/db/schema';
import { logger } from './logger.js';

export interface AuditEvent {
  actor_user_id?: string | null;
  action: string;
  target_type?: string;
  target_id?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export async function audit(event: AuditEvent): Promise<void> {
  try {
    await getDb()
      .insert(audit_log)
      .values({
        actor_user_id: event.actor_user_id ?? null,
        action: event.action,
        target_type: event.target_type ?? null,
        target_id: event.target_id ?? null,
        metadata: event.metadata ?? {},
        ip: event.ip ?? null,
      });
  } catch (err) {
    // Audit must never crash a request, but it must be loud in logs.
    logger.error({ err, event }, 'audit write failed');
  }
}
