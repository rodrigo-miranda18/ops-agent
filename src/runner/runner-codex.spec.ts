import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runnerCodexEnvironment } from './runner-codex.js';

const base = {
  PATH: '/usr/local/bin:/usr/bin',
  HOME: '/home/app',
  GIT_AUTHOR_NAME: 'Driva Ops Agent',
  GITHUB_AUTH_MODE: 'app',
  GITHUB_APP_ID: '1',
  GITHUB_APP_CLIENT_ID: 'Iv1.client',
  GITHUB_APP_ORGANIZATION: 'Example-org',
  GITHUB_APP_HEALTH_REPOSITORY: 'service-15',
  GITHUB_APP_PRIVATE_KEY_FILE: '/run/secrets/github.pem',
  GH_TOKEN: 'must-not-leak',
};

describe('runnerCodexEnvironment', () => {
  it('keeps diagnosis free of GitHub credentials', () => {
    const env = runnerCodexEnvironment({ remediation: false }, base);

    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_AUTH_MODE).toBeUndefined();
    expect(env.GITHUB_APP_ID).toBeUndefined();
    expect(env.GITHUB_APP_CLIENT_ID).toBeUndefined();
    expect(env.GITHUB_APP_ORGANIZATION).toBeUndefined();
    expect(env.GITHUB_APP_HEALTH_REPOSITORY).toBeUndefined();
    expect(env.GITHUB_APP_PRIVATE_KEY_FILE).toBeUndefined();
  });

  it.each([false, true])(
    'keeps Go checksum state in the writable dependency cache (remediation=%s)',
    (remediation) => {
      const env = runnerCodexEnvironment({ remediation }, base);

      expect(env.GOPATH).toBe(
        fileURLToPath(
          new URL('../../state/dependency-cache/go-path', import.meta.url),
        ),
      );
      expect(env.GOCACHE).toBe(
        fileURLToPath(
          new URL('../../state/dependency-cache/go-build', import.meta.url),
        ),
      );
      expect(env.GOMODCACHE).toBe(
        fileURLToPath(
          new URL('../../state/dependency-cache/go-mod', import.meta.url),
        ),
      );
    },
  );

  it('adds the renewable wrapper and App helper configuration for remediation', () => {
    const env = runnerCodexEnvironment({ remediation: true }, base);

    expect(env.PATH).toBe('/app/github-bin:/usr/local/bin:/usr/bin');
    expect(env.DRIVA_REAL_PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.GITHUB_AUTH_MODE).toBe('app');
    expect(env.GITHUB_APP_HEALTH_REPOSITORY).toBe('service-15');
    expect(env.GITHUB_APP_PRIVATE_KEY_FILE).toBe('/run/secrets/github.pem');
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it('keeps the static token for the remediation wrapper', () => {
    const env = runnerCodexEnvironment(
      { remediation: true },
      {
        PATH: '/usr/bin',
        GITHUB_AUTH_MODE: 'static',
        GH_TOKEN: 'static-token',
      },
    );

    expect(env.PATH).toBe('/app/github-bin:/usr/bin');
    expect(env.DRIVA_REAL_PATH).toBe('/usr/bin');
    expect(env.GITHUB_AUTH_MODE).toBe('static');
    expect(env.GH_TOKEN).toBe('static-token');
  });
});
