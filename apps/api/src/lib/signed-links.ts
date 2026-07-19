// TP-9 — HMAC signed download links. Token = base64url(`${id}.${exp}`)
// + '.' + base64url(HMAC-SHA256(payload)). The DB stores sha256(token)
// only; revocation and download audit live on the deliverable_links row.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MAX_TTL_DAYS = 14;

function secret(): string {
  const s = process.env.LINK_SIGNING_SECRET;
  if (!s || s.length < 16) {
    throw Object.assign(new Error('LINK_SIGNING_SECRET not configured (min 16 chars)'), {
      code: 'link_signing_unconfigured',
    });
  }
  return s;
}

const b64u = (b: Buffer) => b.toString('base64url');

export function mintLinkToken(
  deliverableId: string,
  ttlDays: number,
): { token: string; tokenHash: string; expiresAt: Date } {
  const days = Math.min(Math.max(ttlDays, 1), MAX_TTL_DAYS);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const payload = `${deliverableId}.${expiresAt.getTime()}`;
  const sig = createHmac('sha256', secret()).update(payload).digest();
  const token = `${b64u(Buffer.from(payload))}.${b64u(sig)}`;
  return { token, tokenHash: sha256(token), expiresAt };
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface VerifiedToken {
  deliverableId: string;
  expiresAt: Date;
  tokenHash: string;
}

export function verifyLinkToken(token: string): VerifiedToken | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let payload: string;
  try {
    payload = Buffer.from(parts[0]!, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = createHmac('sha256', secret()).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(parts[1]!, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [deliverableId, expMs] = payload.split('.');
  const exp = Number(expMs);
  if (!deliverableId || !Number.isFinite(exp)) return null;
  if (Date.now() > exp) return null;
  return { deliverableId, expiresAt: new Date(exp), tokenHash: sha256(token) };
}
