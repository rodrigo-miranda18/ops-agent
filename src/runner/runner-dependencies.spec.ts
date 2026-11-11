import { beforeEach, describe, expect, it, vi } from 'vitest';

const createCredentialsMock = vi.hoisted(() => vi.fn());
const createExecutorMock = vi.hoisted(() => vi.fn());
vi.mock('../github/github-credentials.js', () => ({
  createGitHubCredentialProvider: createCredentialsMock,
}));
vi.mock('../github/gh.js', () => ({
  createGitHubExecutor: createExecutorMock,
  runnerGhError: vi.fn(),
}));

const { createRunnerDependencies } = await import('./runner-dependencies.js');

function mocks() {
  const credential = {
    getCredential: vi.fn(async () => ({
      token: 'token',
      expiresAt: null,
      installationId: null,
    })),
    invalidate: vi.fn(),
  };
  const execute = vi.fn(async () => '1');
  createCredentialsMock.mockReturnValue(credential);
  createExecutorMock.mockReturnValue(execute);
  return { credential, execute };
}

describe('createRunnerDependencies', () => {
  beforeEach(() => {
    createCredentialsMock.mockReset();
    createExecutorMock.mockReset();
  });

  it('checks every remediation repository in App mode', async () => {
    const github = {
      mode: 'app' as const,
      appId: '1',
      clientId: 'Iv1.client',
      organization: 'Example-org',
      healthRepository: 'service-15',
      privateKeyFile: '/run/secrets/github.pem',
      tokenRefreshSkewMs: 300_000,
    };
    const { credential, execute } = mocks();

    const dependencies = createRunnerDependencies(
      {
        github,
        reposDir: '/repos',
        repositorySyncTimeoutMs: 5000,
      },
      { PATH: '/usr/bin', CLICKUP_API_TOKEN: 'hidden' },
    );

    await dependencies.ensureGitHubAccess(['service-15', 'service-17']);

    expect(createCredentialsMock).toHaveBeenCalledOnce();
    expect(createCredentialsMock).toHaveBeenCalledWith(github);
    expect(createExecutorMock).toHaveBeenCalledWith({
      credentials: credential,
      cwd: '/repos',
      timeoutMs: 5000,
      baseEnv: { PATH: '/usr/bin', CLICKUP_API_TOKEN: 'hidden' },
      formatError: expect.any(Function),
    });
    expect(execute).toHaveBeenNthCalledWith(1, [
      'api',
      '/repos/Example-org/service-15',
      '--jq',
      '.full_name',
    ]);
    expect(execute).toHaveBeenNthCalledWith(2, [
      'api',
      '/repos/Example-org/service-17',
      '--jq',
      '.full_name',
    ]);
    expect(dependencies.github).toBe(execute);
  });

  it('keeps the user credential preflight in static mode', async () => {
    const github = { mode: 'static' as const, token: 'static-token' };
    const { execute } = mocks();
    const dependencies = createRunnerDependencies({
      github,
      reposDir: '/repos',
      repositorySyncTimeoutMs: 5000,
    });

    await dependencies.ensureGitHubAccess(['service-15']);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(['api', 'user', '--jq', '.login']);
  });
});
