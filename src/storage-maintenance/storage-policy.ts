import {
  type StorageAction,
  type StorageInventory,
} from './storage-maintenance.types.js';

export interface StoragePolicyInput {
  inventory: StorageInventory;
  highBytes?: number;
  targetBytes?: number;
  execute: boolean;
  afterIncrementalCleanup?: boolean;
}

export function planStorageMaintenance(
  input: StoragePolicyInput,
): StorageAction[] {
  const { inventory, highBytes, targetBytes, afterIncrementalCleanup } = input;

  if (afterIncrementalCleanup) {
    return targetBytes !== undefined &&
      inventory.dependencyCacheBytes > targetBytes
      ? [{ type: 'coordinated-dependency-reset' }]
      : [];
  }

  const actions: StorageAction[] = [];
  if (highBytes === undefined || inventory.dependencyCacheBytes > highBytes) {
    actions.push({ type: 'prune-dependency-caches' });
  }
  actions.push(
    ...inventory.repositories.map(({ directory }) => ({
      type: 'git-gc' as const,
      repository: directory,
    })),
    ...inventory.orphanWorktrees.map(({ directory }) => ({
      type: 'remove-orphan-worktree' as const,
      directory,
    })),
  );
  return actions;
}
