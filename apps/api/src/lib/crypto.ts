// Phase 5 — AES-256-GCM with HKDF-derived per-purpose key from MASTER_KEY.
//
// Layout of a sealed value (returned to callers and stored in DB):
//   { ciphertext: base64, iv: base64(12B), tag: base64(16B), salt: base64(16B), purpose: string }
//
// HKDF: hmac-sha256, salt is per-record (16 bytes), info = `vibe:${purpose}`.
// Decryption fails on tampering (auth-tag mismatch) and on wrong purpose.
//
// `MASTER_KEY` env var must be 64 hex characters (32 raw bytes).

import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_LEN = 16;
const KEY_LEN = 32;

export interface SealedValue {
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
  purpose: string;
}

function masterKeyBytes(): Buffer {
  const k = Buffer.from(env.MASTER_KEY, 'hex');
  if (k.length !== 32) throw new Error('MASTER_KEY must be 32 bytes (64 hex chars)');
  return k;
}

function deriveKey(salt: Buffer, purpose: string): Buffer {
  const info = Buffer.from(`vibe:${purpose}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', masterKeyBytes(), salt, info, KEY_LEN));
}

export function seal(plaintext: string, purpose: string): SealedValue {
  const iv = crypto.randomBytes(IV_LEN);
  const salt = crypto.randomBytes(SALT_LEN);
  const key = deriveKey(salt, purpose);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LEN) throw new Error(`unexpected tag length ${tag.length}`);
  return {
    ciphertext: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    salt: salt.toString('base64'),
    purpose,
  };
}

export function open(sealed: SealedValue, expectedPurpose: string): string {
  if (sealed.purpose !== expectedPurpose) {
    throw new Error(`crypto purpose mismatch: ${sealed.purpose} != ${expectedPurpose}`);
  }
  const iv = Buffer.from(sealed.iv, 'base64');
  const salt = Buffer.from(sealed.salt, 'base64');
  const ct = Buffer.from(sealed.ciphertext, 'base64');
  const tag = Buffer.from(sealed.tag, 'base64');
  const key = deriveKey(salt, sealed.purpose);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// For UI display only. Last 4 chars of the key, prefixed with the standard
// `sk-ant-` prefix and ellipsis. Never returns enough material to be useful.
export function fingerprint(key: string): string {
  if (key.length < 8) return '***';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
