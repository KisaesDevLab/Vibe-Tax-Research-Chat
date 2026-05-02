// Phase 2 — sanity check that the schema barrel exports everything.
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index.js';

const expected = [
  'users',
  'roleEnum',
  'auth_refresh_tokens',
  'audit_log',
  'settings',
  'SETTING_KEYS',
  'models',
  'skills',
  'skill_versions',
  'skills_sync_runs',
  'custom_skills',
  'chats',
  'messages',
  'primary_source_consultations',
  'chat_attachments',
  'usage_events',
  'usage_daily',
  'reference_documents',
  'reference_chunks',
  'referenceStatusEnum',
  'authority_cache',
];

describe('schema barrel', () => {
  it.each(expected)('exports %s', (name) => {
    expect((schema as Record<string, unknown>)[name]).toBeDefined();
  });
});
