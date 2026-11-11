import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { githubConfigFromEnv } from './github-config.js';

describe('githubConfigFromEnv', () => {
  let directory: string;
  let keyPath: string;

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'github-config-'));
    keyPath = path.join(directory, 'private-key.pem');
    writeFileSync(keyPath, 'test private key', { mode: 0o600 });
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('parses static mode with GH_TOKEN', () => {
    expect(
      githubConfigFromEnv({ GITHUB_AUTH_MODE: 'static', GH_TOKEN: 'token' }),
    ).toEqual({ mode: 'static', token: 'token' });
  });

  it('defaults to static mode only when GH_TOKEN is present', () => {
    expect(githubConfigFromEnv({ GH_TOKEN: 'token' })).toEqual({
      mode: 'static',
      token: 'token',
    });
    expect(() => githubConfigFromEnv({})).toThrow(
      'GITHUB_AUTH_MODE must be static or app',
    );
  });

  it('parses app mode and converts refresh skew to milliseconds', () => {
    expect(
      githubConfigFromEnv({
        GITHUB_AUTH_MODE: 'app',
        GITHUB_APP_ID: '123',
        GITHUB_APP_CLIENT_ID: 'Iv1.client',
        GITHUB_APP_ORGANIZATION: 'Example-org',
        GITHUB_APP_HEALTH_REPOSITORY: 'service-15',
        GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
        GITHUB_APP_INSTALLATION_ID: '456',
        GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS: '300',
      }),
    ).toEqual({
      mode: 'app',
      appId: '123',
      clientId: 'Iv1.client',
      organization: 'Example-org',
      healthRepository: 'service-15',
      privateKeyFile: keyPath,
      installationId: 456,
      tokenRefreshSkewMs: 300_000,
    });
  });

  it('rejects an unknown mode', () => {
    expect(() => githubConfigFromEnv({ GITHUB_AUTH_MODE: 'oauth' })).toThrow(
      'GITHUB_AUTH_MODE must be static or app, received: oauth',
    );
  });

  it('requires a static token', () => {
    expect(() => githubConfigFromEnv({ GITHUB_AUTH_MODE: 'static' })).toThrow(
      'GH_TOKEN is required when GITHUB_AUTH_MODE=static',
    );
  });

  it.each([
    ['GITHUB_APP_ID', 'GITHUB_APP_ID'],
    ['GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_ID'],
    ['GITHUB_APP_ORGANIZATION', 'GITHUB_APP_ORGANIZATION'],
    ['GITHUB_APP_HEALTH_REPOSITORY', 'GITHUB_APP_HEALTH_REPOSITORY'],
    ['GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_PRIVATE_KEY_FILE'],
  ] as const)('requires app field %s', (field, expected) => {
    const env = {
      GITHUB_AUTH_MODE: 'app',
      GITHUB_APP_ID: '123',
      GITHUB_APP_CLIENT_ID: 'Iv1.client',
      GITHUB_APP_ORGANIZATION: 'Example-org',
      GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
    };
    delete env[field];

    expect(() => githubConfigFromEnv(env)).toThrow(
      `${expected} is required when GITHUB_AUTH_MODE=app`,
    );
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'rejects non-positive installation ID %s',
    (installationId) => {
      expect(() =>
        githubConfigFromEnv({
          GITHUB_AUTH_MODE: 'app',
          GITHUB_APP_ID: '123',
          GITHUB_APP_CLIENT_ID: 'Iv1.client',
          GITHUB_APP_ORGANIZATION: 'Example-org',
          GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
          GITHUB_APP_INSTALLATION_ID: installationId,
        }),
      ).toThrow('GITHUB_APP_INSTALLATION_ID must be a positive integer');
    },
  );

  it.each(['0', '3600', '3601', 'abc'])(
    'rejects refresh skew outside the token lifetime: %s',
    (refreshSkew) => {
      expect(() =>
        githubConfigFromEnv({
          GITHUB_AUTH_MODE: 'app',
          GITHUB_APP_ID: '123',
          GITHUB_APP_CLIENT_ID: 'Iv1.client',
          GITHUB_APP_ORGANIZATION: 'Example-org',
          GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
          GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS: refreshSkew,
        }),
      ).toThrow(
        'GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS must be an integer between 1 and 3599',
      );
    },
  );

  it('rejects an unreadable key path', () => {
    const missingKeyPath = path.join(directory, 'missing.pem');
    expect(() =>
      githubConfigFromEnv({
        GITHUB_AUTH_MODE: 'app',
        GITHUB_APP_ID: '123',
        GITHUB_APP_CLIENT_ID: 'Iv1.client',
        GITHUB_APP_ORGANIZATION: 'Example-org',
        GITHUB_APP_PRIVATE_KEY_FILE: missingKeyPath,
      }),
    ).toThrow(`GITHUB_APP_PRIVATE_KEY_FILE is not readable: ${missingKeyPath}`);
  });
});
