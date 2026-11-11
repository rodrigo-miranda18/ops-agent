import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { dependencyInstallationPaths } from '../git/dependencies.js';
import {
  executeStorageActions,
  type StorageCleanupConfig,
} from './storage-cleanup.js';

const config: StorageCleanupConfig = {
  dependencyCacheDir: '/app/state/dependency-cache',
  dependencyStateFile: '/app/state/dependency-fingerprints.json',
  reposDir: '/app/repos',
  temporaryDir: tmpdir(),
  timeoutMs: 90_000,
  repositorySyncTimeoutMs: 30_000,
  environment: {},
};

function successfulProcess() {
  return Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' });
}

describe('executeStorageActions', () => {
  it('runs incremental cache cleanup, git gc and planned worktree removal', async () => {
    const runProcess = vi.fn(successfulProcess);
    const runGit = vi.fn().mockResolvedValue('');
    const remove = vi.fn().mockResolvedValue(undefined);
    const worktree = path.join(tmpdir(), 'driva-remediation-42-old');

    const results = await executeStorageActions(
      [
        { type: 'prune-dependency-caches' },
        { type: 'git-gc', repository: '/app/repos/service' },
        { type: 'remove-orphan-worktree', directory: worktree },
      ],
      config,
      {
        runProcess,
        runGit,
        remove,
        isWorktreeSafeToRemove: vi.fn().mockResolvedValue(true),
      },
    );

    expect(runProcess.mock.calls).toEqual([
      [
        'npm',
        ['cache', 'clean', '--force'],
        expect.objectContaining({
          timeoutMs: 90_000,
          env: expect.objectContaining({
            npm_config_cache: '/app/state/dependency-cache/npm',
          }),
        }),
      ],
      [
        'pnpm',
        ['store', 'prune', '--store-dir=/app/state/dependency-cache/pnpm'],
        expect.objectContaining({ timeoutMs: 90_000 }),
      ],
      [
        'go',
        ['clean', '-cache', '-modcache'],
        expect.objectContaining({
          timeoutMs: 90_000,
          env: expect.objectContaining({
            GOCACHE: '/app/state/dependency-cache/go-build',
            GOMODCACHE: '/app/state/dependency-cache/go-mod',
          }),
        }),
      ],
    ]);
    expect(runGit).toHaveBeenCalledWith(
      { repositorySyncTimeoutMs: 30_000 },
      '/app/repos/service',
      ['gc', '--auto'],
    );
    expect(remove).toHaveBeenCalledWith(worktree);
    expect(results.map(({ status }) => status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
  });

  it('reports sanitized subprocess failures and stops that action', async () => {
    const runProcess = vi.fn().mockResolvedValue({
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: 'Authorization: Bearer-secret',
    });

    const [result] = await executeStorageActions(
      [{ type: 'prune-dependency-caches' }],
      config,
      { runProcess },
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: 'npm cache clean failed: Authorization: [REDACTED]',
    });
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it('rejects worktree deletion outside the agent temporary layout', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);

    const [result] = await executeStorageActions(
      [{ type: 'remove-orphan-worktree', directory: '/app/repos/service' }],
      config,
      { remove },
    );

    expect(result).toMatchObject({ status: 'failed' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('never removes a regular clone under an agent-like temporary path', async () => {
    const worktree = await mkdtemp(
      path.join(tmpdir(), 'driva-remediation-clone-'),
    );
    const reposDir = await mkdtemp(path.join(tmpdir(), 'storage-repos-'));
    await mkdir(path.join(worktree, 'repository', '.git'), { recursive: true });
    const remove = vi.fn().mockResolvedValue(undefined);
    const runGit = vi
      .fn()
      .mockImplementation(async (_config, _repository, args) =>
        args[0] === 'rev-list' ? '0' : '',
      );

    try {
      const [result] = await executeStorageActions(
        [{ type: 'remove-orphan-worktree', directory: worktree }],
        { ...config, reposDir },
        { remove, runGit },
      );

      expect(result).toMatchObject({ status: 'skipped' });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(reposDir, { recursive: true, force: true });
    }
  });

  it('skips a worktree that is not safe to remove', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const worktree = path.join(tmpdir(), 'driva-remediation-42-dirty');

    const [result] = await executeStorageActions(
      [{ type: 'remove-orphan-worktree', directory: worktree }],
      config,
      {
        remove,
        isWorktreeSafeToRemove: vi.fn().mockResolvedValue(false),
      },
    );

    expect(result).toMatchObject({ status: 'skipped' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('resets only managed dependencies and rebuilds them once', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const synchronizeDependencies = vi.fn().mockResolvedValue(undefined);

    const [result] = await executeStorageActions(
      [{ type: 'coordinated-dependency-reset' }],
      config,
      { remove, synchronizeDependencies },
    );

    expect(remove.mock.calls.map(([target]) => target)).toEqual([
      config.dependencyCacheDir,
      config.dependencyStateFile,
      ...dependencyInstallationPaths(
        config.reposDir,
        config.dependencyCacheDir,
      ),
    ]);
    expect(synchronizeDependencies).toHaveBeenCalledOnce();
    expect(synchronizeDependencies).toHaveBeenCalledWith(
      {
        enabled: true,
        reposDir: config.reposDir,
        timeoutMs: config.timeoutMs,
        repositorySyncTimeoutMs: config.repositorySyncTimeoutMs,
        cacheDir: config.dependencyCacheDir,
        stateFile: config.dependencyStateFile,
      },
      expect.any(Function),
    );
    expect(result).toMatchObject({ status: 'completed' });
  });

  it('reports a failed coordinated reset when dependency rebuild fails', async () => {
    const synchronizeDependencies = vi
      .fn()
      .mockRejectedValue(new Error('controlled rebuild failure'));

    const [result] = await executeStorageActions(
      [{ type: 'coordinated-dependency-reset' }],
      config,
      { remove: vi.fn().mockResolvedValue(undefined), synchronizeDependencies },
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: 'controlled rebuild failure',
    });
  });
});
