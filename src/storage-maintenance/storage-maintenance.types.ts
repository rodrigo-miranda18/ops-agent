export const DEPENDENCY_CACHE_KINDS = [
  'npm',
  'pnpm',
  'goBuild',
  'goMod',
] as const;

export type DependencyCacheKind = (typeof DEPENDENCY_CACHE_KINDS)[number];

export interface RepositoryStorageInventory {
  name: string;
  directory: string;
  totalBytes: number;
  gitBytes: number;
  dependencyBytes: number;
}

export interface OrphanWorktreeInventory {
  directory: string;
  ageMs: number;
  bytes: number;
}

export interface StorageInventory {
  authoritativeStateBytes: number;
  dependencyCacheBytes: number;
  cacheBytesByKind: Record<DependencyCacheKind, number>;
  repositories: RepositoryStorageInventory[];
  orphanWorktrees: OrphanWorktreeInventory[];
}

export type StorageAction =
  | { type: 'prune-dependency-caches' }
  | { type: 'git-gc'; repository: string }
  | { type: 'remove-orphan-worktree'; directory: string }
  | { type: 'coordinated-dependency-reset' };

export const STORAGE_ACTION_STATUSES = [
  'completed',
  'skipped',
  'failed',
] as const;
export type StorageActionStatus = (typeof STORAGE_ACTION_STATUSES)[number];

export interface StorageActionResult {
  action: StorageAction;
  status: StorageActionStatus;
  durationMs: number;
  error?: string;
}
