import { describe, expect, it, vi } from 'vitest';
import type { GitHubConfig } from '../config/github-config.js';
import type { GitHubCredentialProvider } from './github-credentials.js';
import {
  gitCredentialResponse,
  parseGitCredentialInput,
} from './git-credential-app.js';

const config: GitHubConfig = { mode: 'static', token: 'static-token' };

function credentials(
  tokens = ['installation-token'],
): GitHubCredentialProvider & {
  getCredential: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  return {
    getCredential: vi.fn(async () => ({
      token: tokens[Math.min(index++, tokens.length - 1)],
      expiresAt: null,
      installationId: null,
    })),
    invalidate: vi.fn(),
  };
}

describe('Git credential protocol', () => {
  it('parses known fields and ignores malformed lines', () => {
    expect(
      parseGitCredentialInput(
        'protocol=https\nmalformed\nhost=github.com\npath=Driva/repo.git\n=value\n\n',
      ),
    ).toEqual({
      protocol: 'https',
      host: 'github.com',
      path: 'Driva/repo.git',
    });
  });

  it('returns a current token for GitHub HTTPS', async () => {
    const provider = credentials();

    await expect(
      gitCredentialResponse(
        'get',
        'protocol=https\nhost=github.com\npath=Driva/repo.git\n\n',
        config,
        provider,
      ),
    ).resolves.toBe('username=x-access-token\npassword=installation-token\n\n');
    expect(provider.getCredential).toHaveBeenCalledOnce();
  });

  it.each([
    ['get', 'protocol=https\nhost=gitlab.com\n\n'],
    ['get', 'protocol=ssh\nhost=github.com\n\n'],
    ['store', 'protocol=https\nhost=github.com\n\n'],
    ['erase', 'protocol=https\nhost=github.com\n\n'],
  ])(
    'returns no credential for %s with unsupported input',
    async (operation, input) => {
      const provider = credentials();

      await expect(
        gitCredentialResponse(operation, input, config, provider),
      ).resolves.toBe('');
      expect(provider.getCredential).not.toHaveBeenCalled();
    },
  );

  it('obtains a fresh credential for every get invocation', async () => {
    const provider = credentials(['token-1', 'token-2']);
    const input = 'protocol=https\nhost=github.com\n\n';

    await expect(
      gitCredentialResponse('get', input, config, provider),
    ).resolves.toContain('password=token-1');
    await expect(
      gitCredentialResponse('get', input, config, provider),
    ).resolves.toContain('password=token-2');
  });

  it('sanitizes credential and PEM content from provider failures', async () => {
    const provider = credentials();
    provider.getCredential.mockRejectedValue(
      new Error(
        'failed password=ghs_secret-token-value\n-----BEGIN PRIVATE KEY-----private-material',
      ),
    );

    const error = await gitCredentialResponse(
      'get',
      'protocol=https\nhost=github.com\n\n',
      config,
      provider,
    ).catch((reason: Error) => reason);

    expect(error.message).not.toContain('ghs_secret-token-value');
    expect(error.message).not.toContain('private-material');
  });
});
