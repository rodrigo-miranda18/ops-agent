import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChildProcess } from '../common/fake-child-process.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const {
  CODEX_READ_NETWORK_PERMISSIONS,
  codexExecArgs,
  codexSandboxPermissions,
  runCodexExec,
} = await import('./codex.js');

describe('codex adapter', () => {
  let child: FakeChildProcess;

  beforeEach(() => {
    child = new FakeChildProcess();
    spawnMock.mockReset().mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('monta os args de diagnóstico somente leitura com modelo e imagens', () => {
    expect(
      codexExecArgs({
        addDir: '/results/1',
        permissions: CODEX_READ_NETWORK_PERMISSIONS,
        model: 'gpt-x',
        imagePaths: ['/a.png', '/b.jpg'],
      }),
    ).toEqual([
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--add-dir',
      '/results/1',
      '-c',
      'default_permissions="driva-debug-read-network"',
      '-c',
      'approval_policy="never"',
      '-c',
      'allow_login_shell=false',
      '--model',
      'gpt-x',
      '--image',
      '/a.png',
      '--image',
      '/b.jpg',
      '-',
    ]);
  });

  it('monta os args de sandbox sem modelo', () => {
    expect(
      codexExecArgs({
        addDir: '/t',
        permissions: codexSandboxPermissions('danger-full-access'),
      }),
    ).toEqual([
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--add-dir',
      '/t',
      '-c',
      'sandbox_mode="danger-full-access"',
      '-c',
      'approval_policy="never"',
      '-c',
      'allow_login_shell=false',
      '-',
    ]);
  });

  it('envia o prompt no stdin com env e cwd explícitos', async () => {
    const promise = runCodexExec({
      codexBin: '/bin/codex',
      cwd: '/repos',
      env: { PATH: '/bin' },
      timeoutMs: 1000,
      prompt: 'diagnostique',
      addDir: '/t',
      permissions: CODEX_READ_NETWORK_PERMISSIONS,
    });
    child.finish({ stdout: 'ok', stderr: 'warn' }, 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: 'warn',
    });
    expect(child.input).toBe('diagnostique');
    const [command, , options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(command).toBe('/bin/codex');
    expect(options.cwd).toBe('/repos');
    expect(options.env).toEqual({ PATH: '/bin' });
  });

  it('mata no timeout e reporta exit code 1 quando fechado por sinal', async () => {
    vi.useFakeTimers();
    const promise = runCodexExec({
      codexBin: 'codex',
      cwd: '/repos',
      env: {},
      timeoutMs: 500,
      prompt: 'p',
      addDir: '/t',
      permissions: CODEX_READ_NETWORK_PERMISSIONS,
    });
    vi.advanceTimersByTime(500);
    expect(child.killed).toEqual(['SIGTERM']);
    child.finish({}, null, 'SIGTERM');

    await expect(promise).resolves.toMatchObject({
      exitCode: 1,
      signal: 'SIGTERM',
    });
  });
});
