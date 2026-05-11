import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

// Env vars must be set before any module under test imports `config/env`.
beforeAll(() => {
  process.env.MASTER_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.JWT_REFRESH_SECRET = crypto.randomBytes(64).toString('hex');
  process.env.DATABASE_URL = 'postgres://x/x';
  process.env.REDIS_URL = 'redis://localhost:6379';
});

// Mock the settings store so buildMailer can be driven by test scenarios
// without a real DB. We rebuild the module under test between cases to
// invalidate its internal cache.
const settingsState: Record<string, unknown> = {};
vi.mock('../settings-store.js', () => ({
  getSetting: vi.fn(async (key: string) => settingsState[key] ?? null),
}));

// Mock both provider impls so we can assert which one was selected
// without standing up an actual SMTP server or HTTP client.
vi.mock('./smtp.js', () => ({
  createSmtpProvider: vi.fn(() => ({
    kind: 'smtp',
    verify: vi.fn(),
    send: vi.fn(),
  })),
}));
vi.mock('./resend.js', () => ({
  createResendProvider: vi.fn(() => ({
    kind: 'resend',
    verify: vi.fn(),
    send: vi.fn(),
  })),
}));

beforeEach(() => {
  for (const k of Object.keys(settingsState)) delete settingsState[k];
  vi.resetModules();
  vi.clearAllMocks();
});

describe('buildMailer', () => {
  it('returns null when EMAIL_CONFIG is not set', async () => {
    const { buildMailer } = await import('./provider.js');
    const m = await buildMailer();
    expect(m).toBeNull();
  });

  it('returns null when SMTP config is set but no password is on file', async () => {
    settingsState['email_config'] = {
      provider: 'smtp',
      from_address: 'no-reply@firm.example',
      from_name: 'Firm',
      smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'u' },
    };
    const { buildMailer } = await import('./provider.js');
    const m = await buildMailer();
    expect(m).toBeNull();
  });

  it('selects the SMTP impl when provider=smtp and a password exists', async () => {
    settingsState['email_config'] = {
      provider: 'smtp',
      from_address: 'no-reply@firm.example',
      from_name: 'Firm',
      smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'u' },
    };
    settingsState['email_smtp_password'] = 'p4ssw0rd';
    const { buildMailer } = await import('./provider.js');
    const m = await buildMailer();
    expect(m?.kind).toBe('smtp');
  });

  it('selects the Resend impl when provider=resend and an api key exists', async () => {
    settingsState['email_config'] = {
      provider: 'resend',
      from_address: 'no-reply@firm.example',
      from_name: 'Firm',
    };
    settingsState['email_resend_api_key'] = 're_test_key';
    const { buildMailer } = await import('./provider.js');
    const m = await buildMailer();
    expect(m?.kind).toBe('resend');
  });

  it('returns null when provider=resend but no api key is on file', async () => {
    settingsState['email_config'] = {
      provider: 'resend',
      from_address: 'no-reply@firm.example',
      from_name: 'Firm',
    };
    const { buildMailer } = await import('./provider.js');
    const m = await buildMailer();
    expect(m).toBeNull();
  });

  it('caches the result so back-to-back calls do not re-read settings', async () => {
    settingsState['email_config'] = {
      provider: 'resend',
      from_address: 'a@b.c',
      from_name: 'Firm',
    };
    settingsState['email_resend_api_key'] = 'key';
    const settingsModule = await import('../settings-store.js');
    const { buildMailer } = await import('./provider.js');
    await buildMailer();
    await buildMailer();
    // 2 settings reads on the first call (config + secret), 0 on the second.
    expect(vi.mocked(settingsModule.getSetting)).toHaveBeenCalledTimes(2);
  });

  it('resetMailer() forces a rebuild from current settings', async () => {
    settingsState['email_config'] = {
      provider: 'resend',
      from_address: 'a@b.c',
      from_name: 'Firm',
    };
    settingsState['email_resend_api_key'] = 'key';
    const settingsModule = await import('../settings-store.js');
    const { buildMailer, resetMailer } = await import('./provider.js');
    await buildMailer();
    resetMailer();
    await buildMailer();
    expect(vi.mocked(settingsModule.getSetting)).toHaveBeenCalledTimes(4);
  });
});
