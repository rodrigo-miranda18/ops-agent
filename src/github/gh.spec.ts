import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessResult } from '../common/run-process.js';
import type { GitHubCredentialProvider } from './github-credentials.js';

const runProcessMock = vi.hoisted(() => vi.fn());
vi.mock('../common/run-process.js', () => ({ runProcess: runProcessMock }));

const { createGitHubExecutor, runnerGhError, serviceGhError } =
  await import('./gh.js');

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: ' OPEN \n',
    stderr: '',
    ...overrides,
  };
}

function credentials(tokens = ['token-1']): GitHubCredentialProvider & {
  getCredential: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
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

describe('createGitHubExecutor', () => {
  beforeEach(() => {
    runProcessMock.mockReset();
  });

  it('gets a current credential immediately before every gh process', async () => {
    const provider = credentials(['token-1', 'token-2']);
    runProcessMock.mockResolvedValue(result());
    const execute = createGitHubExecutor({
      credentials: provider,
      cwd: '/repos',
      timeoutMs: 1000,
      baseEnv: {
        PATH: '/usr/bin',
        HOME: '/home/app',
        CLICKUP_API_TOKEN: 'hidden',
      },
    });

    await expect(execute(['pr', 'view', 'url'])).resolves.toBe('OPEN');
    await execute(['issue', 'view', 'url']);

    expect(provider.getCredential).toHaveBeenCalledTimes(2);
    expect(runProcessMock).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['pr', 'view', 'url'],
      {
        cwd: '/repos',
        timeoutMs: 1000,
        env: {
          PATH: '/usr/bin',
          HOME: '/home/app',
          GH_TOKEN: 'token-1',
          GH_PROMPT_DISABLED: 'true',
        },
      },
    );
    expect(runProcessMock.mock.calls[0]?.[2].env).not.toHaveProperty(
      'CLICKUP_API_TOKEN',
    );
    expect(runProcessMock.mock.calls[1]?.[2].env.GH_TOKEN).toBe('token-2');
  });

  it('invalidates and retries once after an expired authentication response', async () => {
    const provider = credentials(['expired-token', 'fresh-token']);
    runProcessMock
      .mockResolvedValueOnce(
        result({ exitCode: 1, stderr: 'HTTP 401: Bad credentials' }),
      )
      .mockResolvedValueOnce(result({ stdout: 'ok\n' }));
    const execute = createGitHubExecutor({
      credentials: provider,
      timeoutMs: 1000,
      baseEnv: { PATH: '/usr/bin' },
    });

    await expect(execute(['api', '/user'])).resolves.toBe('ok');
    expect(provider.invalidate).toHaveBeenCalledTimes(1);
    expect(provider.getCredential).toHaveBeenCalledTimes(2);
    expect(runProcessMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    'HTTP 403: API rate limit exceeded',
    'HTTP 403: Resource not accessible by integration',
  ])('does not retry non-expiration failures: %s', async (stderr) => {
    const provider = credentials();
    runProcessMock.mockResolvedValue(result({ exitCode: 1, stderr }));
    const execute = createGitHubExecutor({
      credentials: provider,
      timeoutMs: 1000,
      baseEnv: { PATH: '/usr/bin' },
      formatError: serviceGhError,
    });

    await expect(execute(['api', '/user'])).rejects.toThrow(stderr);
    expect(provider.invalidate).not.toHaveBeenCalled();
    expect(runProcessMock).toHaveBeenCalledTimes(1);
  });

  it('sanitizes service errors before they reach Nest callers', () => {
    const message = serviceGhError(
      ['api', '/user'],
      { exitCode: 1 },
      {
        stdout: '',
        stderr:
          'Authorization: Bearer secret-value\nhttps://x-access-token:secret-value@github.com/org/repo.git\npassword=secret-value',
      },
    );

    expect(message).toContain('Authorization: [REDACTED]');
    expect(message).toContain('https://[REDACTED_CREDENTIALS]@github.com');
    expect(message).toContain('password=[REDACTED]');
    expect(message).not.toContain('secret-value');
  });

  it('preserves runner error sanitization and command override', async () => {
    const provider = credentials();
    runProcessMock.mockResolvedValue(
      result({
        exitCode: 1,
        stderr: `${'x'.repeat(3000)} https://u:p@github.com`,
      }),
    );
    const execute = createGitHubExecutor({
      credentials: provider,
      timeoutMs: 1000,
      baseEnv: { PATH: '/usr/bin' },
      command: '/usr/local/bin/gh',
      formatError: runnerGhError,
    });

    const error = await execute(['pr', 'close', 'url']).catch(
      (reason: Error) => reason,
    );
    expect(error.message.startsWith('gh pr close failed: ')).toBe(true);
    expect(error.message).toContain(
      'https://[REDACTED_CREDENTIALS]@github.com',
    );
    expect(error.message.length).toBe('gh pr close failed: '.length + 2000);
    expect(runProcessMock.mock.calls[0]?.[0]).toBe('/usr/local/bin/gh');
  });
});
