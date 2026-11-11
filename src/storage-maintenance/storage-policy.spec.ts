import { describe, expect, it } from 'vitest';
import {
  planStorageMaintenance,
  type StoragePolicyInput,
} from './storage-policy.js';
import { type StorageInventory } from './storage-maintenance.types.js';

function inventory(dependencyCacheBytes: number): StorageInventory {
  return {
    authoritativeStateBytes: 10,
    dependencyCacheBytes,
    cacheBytesByKind: { npm: 0, pnpm: 0, goBuild: 0, goMod: 0 },
    repositories: [
      {
        name: 'service',
        directory: '/repos/service',
        totalBytes: 100,
        gitBytes: 20,
        dependencyBytes: 30,
      },
    ],
    orphanWorktrees: [
      { directory: '/tmp/driva-remediation-42-old', ageMs: 100, bytes: 50 },
    ],
  };
}

function plan(overrides: Partial<StoragePolicyInput> = {}) {
  return planStorageMaintenance({
    inventory: inventory(50),
    highBytes: 100,
    targetBytes: 60,
    execute: true,
    afterIncrementalCleanup: false,
    ...overrides,
  });
}

describe('planStorageMaintenance', () => {
  it('plans repository maintenance and eligible worktree cleanup below high', () => {
    expect(plan()).toEqual([
      { type: 'git-gc', repository: '/repos/service' },
      {
        type: 'remove-orphan-worktree',
        directory: '/tmp/driva-remediation-42-old',
      },
    ]);
  });

  it('plans cache pruning before other incremental actions above high', () => {
    expect(plan({ inventory: inventory(101) })).toEqual([
      { type: 'prune-dependency-caches' },
      { type: 'git-gc', repository: '/repos/service' },
      {
        type: 'remove-orphan-worktree',
        directory: '/tmp/driva-remediation-42-old',
      },
    ]);
  });

  it('plans a coordinated reset only after pruning remains above target', () => {
    expect(
      plan({
        inventory: inventory(61),
        afterIncrementalCleanup: true,
      }),
    ).toEqual([{ type: 'coordinated-dependency-reset' }]);

    expect(
      plan({
        inventory: inventory(60),
        afterIncrementalCleanup: true,
      }),
    ).toEqual([]);
  });

  it('returns incremental actions without thresholds for manual inspection', () => {
    expect(
      plan({ highBytes: undefined, targetBytes: undefined, execute: false }),
    ).toEqual([
      { type: 'prune-dependency-caches' },
      { type: 'git-gc', repository: '/repos/service' },
      {
        type: 'remove-orphan-worktree',
        directory: '/tmp/driva-remediation-42-old',
      },
    ]);
  });
});
