// SSO (Vibe Auth) — how the OIDC client secret is wrapped at rest (D24).
//
// The package stores it as an opaque string in auth_settings.value
// (`clientSecretWrapped`); we make that string a JSON-encoded SealedValue
// under MASTER_KEY with a fixed HKDF purpose. Kept apart from lib/vibeAuth.ts
// because the DR restore engine (lib/backup/engine.ts) re-keys this value
// from the archive's MASTER_KEY to this server's, and must not drag Express
// and the engine into the restore path.
import { openWith, sealWith, type SealedValue } from './crypto.js';

export const VIBE_AUTH_SECRET_PURPOSE = 'vibe_auth.client_secret';

export function wrapClientSecretWith(masterKeyHex: string, plaintext: string): string {
  return JSON.stringify(sealWith(masterKeyHex, plaintext, VIBE_AUTH_SECRET_PURPOSE));
}

export function unwrapClientSecretWith(masterKeyHex: string, wrapped: string): string {
  return openWith(masterKeyHex, JSON.parse(wrapped) as SealedValue, VIBE_AUTH_SECRET_PURPOSE);
}
