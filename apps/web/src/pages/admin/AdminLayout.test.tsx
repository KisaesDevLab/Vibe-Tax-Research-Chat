// Version label shown in the admin sidebar footer. Tag builds stamp
// "v0.10.1" into APP_VERSION; main-push builds stamp the full commit sha
// (release.yml build-args), which must be shortened for display.
import { describe, expect, it } from 'vitest';
import { versionLabel } from './AdminLayout';

describe('versionLabel', () => {
  it('passes tag versions through', () => {
    expect(
      versionLabel({ version: 'v0.10.1', git_sha: 'a03cfcc0', build_date: '2026-08-10' }),
    ).toBe('v0.10.1');
  });

  it('shortens a full-sha version from main-push builds', () => {
    const sha = 'a03cfcc0123456789abcdef0123456789abcdef0';
    expect(versionLabel({ version: sha, git_sha: sha, build_date: '2026-08-10' })).toBe(
      'sha-a03cfcc',
    );
  });

  it('passes dev builds through', () => {
    expect(versionLabel({ version: 'dev', git_sha: 'unknown', build_date: 'unknown' })).toBe('dev');
  });
});
