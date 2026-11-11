import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeChildProcess } from '../common/fake-child-process.js';
import type { GitHubConfig } from '../config/github-config.js';
import type { GitHubCredentialProvider } from './github-credentials.js';
import { isWrapperEntrypoint, runGhWrapper } from './gh-wrapper.js';

let directory: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function wrapperDependencies(
  child: FakeChildProcess,
  onConfig?: (config: GitHubConfig) => void,
) {
  const credentials: GitHubCredentialProvider = {
    getCredential: vi.fn(async () => ({
      token: 'current-token',
      expiresAt: null,
      installationId: null,
    })),
    invalidate: vi.fn(),
  };
  return {
    credentials,
    dependencies: {
      createCredentials: vi.fn((config: GitHubConfig) => {
        onConfig?.(config);
        return credentials;
      }),
      spawn: vi.fn(() => child as never),
    },
  };
}

describe('runGhWrapper', () => {
  it('recognizes execution through a symlink as the wrapper entrypoint', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gh-wrapper-entrypoint-'));
    const target = path.join(directory, 'gh-wrapper.js');
    const link = path.join(directory, 'gh');
    await writeFile(target, '#!/usr/bin/env node\n');
    await symlink(target, link);

    expect(isWrapperEntrypoint(pathToFileURL(target).href, link)).toBe(true);
  });

  it('loads static configuration and forwards arguments through the real PATH', async () => {
    const child = new FakeChildProcess();
    const seen: GitHubConfig[] = [];
    const { credentials, dependencies } = wrapperDependencies(child, (config) =>
      seen.push(config),
    );

    const promise = runGhWrapper(
      ['pr', 'view', 'url'],
      {
        GITHUB_AUTH_MODE: 'static',
        GH_TOKEN: 'static-token',
        PATH: '/app/github-bin:/usr/local/bin:/usr/bin',
        DRIVA_REAL_PATH: '/usr/local/bin:/usr/bin',
        CLICKUP_API_TOKEN: 'hidden',
      },
      dependencies,
    );
    await vi.waitFor(() => expect(dependencies.spawn).toHaveBeenCalledOnce());
    child.finish({}, 0);

    await expect(promise).resolves.toBe(0);
    expect(seen).toEqual([{ mode: 'static', token: 'static-token' }]);
    expect(credentials.getCredential).toHaveBeenCalledOnce();
    expect(dependencies.spawn).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', 'url'],
      expect.objectContaining({
        cwd: process.cwd(),
        stdio: 'inherit',
        env: expect.objectContaining({
          PATH: '/usr/local/bin:/usr/bin',
          GH_TOKEN: 'current-token',
          GH_PROMPT_DISABLED: 'true',
        }),
      }),
    );
    expect(dependencies.spawn.mock.calls[0]?.[2].env).not.toHaveProperty(
      'CLICKUP_API_TOKEN',
    );
  });

  it('loads App configuration from the supplied environment', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'gh-wrapper-'));
    const keyPath = path.join(directory, 'private-key.pem');
    await writeFile(keyPath, 'key', { mode: 0o600 });
    const child = new FakeChildProcess();
    const seen: GitHubConfig[] = [];
    const { dependencies } = wrapperDependencies(child, (config) =>
      seen.push(config),
    );

    const promise = runGhWrapper(
      ['api', '/user'],
      {
        GITHUB_AUTH_MODE: 'app',
        GITHUB_APP_ID: '1',
        GITHUB_APP_CLIENT_ID: 'Iv1.client',
        GITHUB_APP_ORGANIZATION: 'Example-org',
        GITHUB_APP_HEALTH_REPOSITORY: 'service-15',
        GITHUB_APP_PRIVATE_KEY_FILE: keyPath,
        PATH: '/app/github-bin:/usr/bin',
        DRIVA_REAL_PATH: '/usr/bin',
      },
      dependencies,
    );
    await vi.waitFor(() => expect(dependencies.spawn).toHaveBeenCalledOnce());
    child.finish({}, 0);

    await promise;
    expect(seen[0]).toMatchObject({
      mode: 'app',
      appId: '1',
      clientId: 'Iv1.client',
      privateKeyFile: keyPath,
    });
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'forwards %s to the child and returns 1 for signal termination',
    async (signal) => {
      const child = new FakeChildProcess();
      const { dependencies } = wrapperDependencies(child);
      const promise = runGhWrapper(
        ['api', '/user'],
        {
          GITHUB_AUTH_MODE: 'static',
          GH_TOKEN: 'token',
          PATH: '/wrapper:/usr/bin',
          DRIVA_REAL_PATH: '/usr/bin',
        },
        dependencies,
      );

      await vi.waitFor(() => expect(dependencies.spawn).toHaveBeenCalledOnce());
      process.emit(signal);
      expect(child.killed).toEqual([signal]);
      child.finish({}, null, signal);

      await expect(promise).resolves.toBe(1);
    },
  );

  it('returns the child exit code', async () => {
    const child = new FakeChildProcess();
    const { dependencies } = wrapperDependencies(child);
    const promise = runGhWrapper(
      ['api', '/user'],
      {
        GITHUB_AUTH_MODE: 'static',
        GH_TOKEN: 'token',
        PATH: '/wrapper:/usr/bin',
        DRIVA_REAL_PATH: '/usr/bin',
      },
      dependencies,
    );
    await vi.waitFor(() => expect(dependencies.spawn).toHaveBeenCalledOnce());
    child.finish({}, 7);

    await expect(promise).resolves.toBe(7);
  });

  it('sanitizes startup errors and returns 1', async () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const child = new FakeChildProcess();
    const { dependencies } = wrapperDependencies(child);
    dependencies.createCredentials.mockImplementation(() => {
      throw new Error('failed with ghs_secret-token-value');
    });

    await expect(
      runGhWrapper(
        ['api', '/user'],
        {
          GITHUB_AUTH_MODE: 'static',
          GH_TOKEN: 'token',
          PATH: '/wrapper:/usr/bin',
          DRIVA_REAL_PATH: '/usr/bin',
        },
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(String(write.mock.calls[0]?.[0])).not.toContain(
      'ghs_secret-token-value',
    );
  });
});
