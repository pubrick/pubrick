import { describe, expect, it } from 'vitest';
import { identityConfig, canonicalMailUrl } from './auth-hosted-policy';
const hosted = {
  PUBRICK_DEPLOYMENT_MODE: 'hosted', SIGNUP_MODE: 'open', AUTH_RATE_LIMIT_ENABLED: true,
  WEB_ORIGIN: 'https://pubrick.example', BETTER_AUTH_URL: 'https://pubrick.example',
  SMTP_HOST: 'smtp.example', SMTP_PORT: 587, SMTP_USER: 'account', SMTP_PASSWORD: 'private', SMTP_FROM: 'pubrick@example.com', SMTP_SECURE: false, SMTP_REQUIRE_TLS: true,
};
describe('hosted identity policy', () => {
  it('keeps default self-hosted installs usable without mail', () => {
    expect(identityConfig({ ...hosted, PUBRICK_DEPLOYMENT_MODE: 'self-hosted', SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASSWORD: undefined, SMTP_FROM: undefined }, 'production')).toEqual({ hosted: false, mail: null });
  });
  it('requires explicit open signup, active rate limiting, matching HTTPS origins and complete SMTP', () => {
    expect(identityConfig(hosted, 'production').hosted).toBe(true);
    for (const override of [{ SIGNUP_MODE: undefined }, { SIGNUP_MODE: 'invite' }, { AUTH_RATE_LIMIT_ENABLED: false }, { WEB_ORIGIN: 'http://pubrick.example', BETTER_AUTH_URL: 'http://pubrick.example' }, { BETTER_AUTH_URL: 'https://other.example' }, { SMTP_PASSWORD: undefined }, { SMTP_REQUIRE_TLS: false }]) {
      expect(() => identityConfig({ ...hosted, ...override }, 'production')).toThrow();
    }
  });
  it('permits plaintext SMTP only for a loopback test server outside production', () => {
    const local = { ...hosted, SMTP_HOST: '127.0.0.1', SMTP_REQUIRE_TLS: false, WEB_ORIGIN: 'http://localhost:3000', BETTER_AUTH_URL: 'http://localhost:3000' };
    expect(identityConfig(local, 'test').mail).not.toBeNull();
    expect(() => identityConfig({ ...local, SMTP_HOST: 'smtp.example' }, 'test')).toThrow();
    expect(() => identityConfig(local, 'production')).toThrow();
    expect(identityConfig({ ...hosted, SMTP_SECURE: true, SMTP_REQUIRE_TLS: false }, 'production').mail).not.toBeNull();
  });
  it('uses canonical mail links and refuses foreign origins or unsafe callback paths', () => {
    const url = 'https://pubrick.example/api/auth/verify-email?token=opaque&callbackURL=%2Fru%2Fverify-email';
    expect(canonicalMailUrl(url, hosted.WEB_ORIGIN)).toBe(url);
    for (const unsafe of ['https://evil.example/api/auth/verify-email?token=opaque', 'https://pubrick.example/api/auth/verify-email?callbackURL=https://evil.example', 'https://pubrick.example/api/auth/verify-email?callbackURL=//evil.example', 'https://pubrick.example/api/auth/verify-email?callbackURL=/unknown/login']) expect(() => canonicalMailUrl(unsafe, hosted.WEB_ORIGIN)).toThrow();
  });
});
