import { describe, expect, it, vi } from 'vitest';
import { RepositoryAccessConflictError } from '../git/repository-access.js';
import { type StorageInventory } from './storage-maintenance.types.js';
import {
  parseStorageMaintenanceArgs,
  runStorageMaintenance,
  type StorageMaintenanceRunnerDependencies,
} from './storage-maintenance-runner.js';

function inventory(cacheBytes: number): StorageInventory {
  return {
    authoritativeStateBytes: 10,
    dependencyCacheBytes: cacheBytes,
    cacheBytesByKind: { npm: cacheBytes, pnpm: 0, goBuild: 0, goMod: 0 },
    repositories: [
      {
        name: 'service',
        directory: '/repos/service',
        totalBytes: 100,
        gitBytes: 20,
        dependencyBytes: 30,
      },
    ],
    orphanWorktrees: [],
  };
}

function dependencies(
  inventories: StorageInventory[],
): StorageMaintenanceRunnerDependencies {
  return {
    config: {
      enabled: false,
      cron: '43 3 * * *',
      dependencyCacheHighBytes: 150,
      dependencyCacheTargetBytes: 100,
      worktreeMinAgeMs: 1,
      timeoutMs: 1000,
    },
    acquireLock: vi
      .fn()
      .mockResolvedValue(vi.fn().mockResolvedValue(undefined)),
    inventory: vi.fn().mockImplementation(async () => {
      const next = inventories.shift();
      if (!next) throw new Error('missing inventory fixture');
      return next;
    }),
    executeActions: vi.fn().mockImplementation(async (actions) =>
      actions.map((action) => ({
        action,
        status: 'completed' as const,
        durationMs: 1,
      })),
    ),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('parseStorageMaintenanceArgs', () => {
  it('defaults to manual dry-run', () => {
    expect(parseStorageMaintenanceArgs([])).toEqual({
      execute: false,
      trigger: 'manual',
    });
    expect(parseStorageMaintenanceArgs(['--dry-run'])).toEqual({
      execute: false,
      trigger: 'manual',
    });
  });

  it('parses execute and cron trigger', () => {
    expect(
      parseStorageMaintenanceArgs(['--execute', '--trigger=cron']),
    ).toEqual({ execute: true, trigger: 'cron' });
  });

  it('rejects mutually exclusive or unknown arguments', () => {
    expect(() =>
      parseStorageMaintenanceArgs(['--dry-run', '--execute']),
    ).toThrow('--dry-run and --execute are mutually exclusive');
    expect(() => parseStorageMaintenanceArgs(['--unknown'])).toThrow(
      'Unknown storage maintenance argument: --unknown',
    );
  });
});

describe('runStorageMaintenance', () => {
  it('plans a dry-run without mutations and releases the lock', async () => {
    const deps = dependencies([inventory(200)]);

    const report = await runStorageMaintenance(
      { execute: false, trigger: 'manual' },
      deps,
    );

    expect(deps.acquireLock).toHaveBeenCalledWith('storage-maintenance');
    expect(deps.executeActions).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      status: 'completed',
      mode: 'dry-run',
      trigger: 'manual',
      before: { dependencyCacheBytes: 200 },
      after: { dependencyCacheBytes: 200 },
      bytesReclaimed: 0,
    });
    expect(report.plannedActions[0]).toEqual({
      type: 'prune-dependency-caches',
    });
    const release = await deps.acquireLock.mock.results[0]?.value;
    expect(release).toHaveBeenCalledOnce();
  });

  it('plans cache pruning during threshold-free calibration dry-run', async () => {
    const deps = dependencies([inventory(50)]);
    deps.config.dependencyCacheHighBytes = undefined;
    deps.config.dependencyCacheTargetBytes = undefined;

    const report = await runStorageMaintenance(
      { execute: false, trigger: 'manual' },
      deps,
    );

    expect(report.plannedActions[0]).toEqual({
      type: 'prune-dependency-caches',
    });
    expect(deps.executeActions).not.toHaveBeenCalled();
  });

  it('executes cache pruning without reset during threshold-free calibration', async () => {
    const deps = dependencies([inventory(50), inventory(20)]);
    deps.config.dependencyCacheHighBytes = undefined;
    deps.config.dependencyCacheTargetBytes = undefined;

    const report = await runStorageMaintenance(
      { execute: true, trigger: 'manual' },
      deps,
    );

    expect(deps.executeActions).toHaveBeenCalledTimes(1);
    expect(deps.executeActions.mock.calls[0]?.[0][0]).toEqual({
      type: 'prune-dependency-caches',
    });
    expect(report.plannedActions).not.toContainEqual({
      type: 'coordinated-dependency-reset',
    });
  });

  it('runs incremental actions without reset when pruning reaches target', async () => {
    const deps = dependencies([inventory(200), inventory(90)]);

    const report = await runStorageMaintenance(
      { execute: true, trigger: 'manual' },
      deps,
    );

    expect(deps.executeActions).toHaveBeenCalledTimes(1);
    expect(deps.executeActions.mock.calls[0]?.[0][0]).toEqual({
      type: 'prune-dependency-caches',
    });
    expect(report).toMatchObject({
      status: 'completed',
      mode: 'execute',
      before: { dependencyCacheBytes: 200 },
      after: { dependencyCacheBytes: 90 },
      bytesReclaimed: 110,
    });
  });

  it('resets and rebuilds only after post-prune inventory remains above target', async () => {
    const deps = dependencies([inventory(200), inventory(120), inventory(20)]);

    const report = await runStorageMaintenance(
      { execute: true, trigger: 'cron' },
      deps,
    );

    expect(deps.executeActions).toHaveBeenCalledTimes(2);
    expect(deps.executeActions.mock.calls[1]?.[0]).toEqual([
      { type: 'coordinated-dependency-reset' },
    ]);
    expect(report).toMatchObject({
      status: 'completed',
      trigger: 'cron',
      after: { dependencyCacheBytes: 20 },
      bytesReclaimed: 180,
    });
  });

  it('returns a safe skip when another process owns the lock', async () => {
    const deps = dependencies([]);
    deps.acquireLock.mockRejectedValue(
      new RepositoryAccessConflictError('Repositories are in use'),
    );

    const report = await runStorageMaintenance(
      { execute: true, trigger: 'cron' },
      deps,
    );

    expect(report).toMatchObject({
      status: 'skipped',
      mode: 'execute',
      trigger: 'cron',
    });
    expect(deps.inventory).not.toHaveBeenCalled();
  });

  it('reports structured summary metadata', async () => {
    const deps = dependencies([inventory(50)]);

    await runStorageMaintenance({ execute: false, trigger: 'manual' }, deps);

    const messages = deps.logger.info.mock.calls.map(([message]) =>
      JSON.parse(message),
    ) as Array<Record<string, unknown>>;
    expect(messages).toContainEqual(
      expect.objectContaining({
        event: 'storage_maintenance_summary',
        status: 'completed',
        mode: 'dry-run',
        trigger: 'manual',
        dependencyCacheBytesBefore: 50,
        dependencyCacheBytesAfter: 50,
      }),
    );
  });
});
