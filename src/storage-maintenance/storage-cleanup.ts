import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../common/run-process.js';
import { sanitize } from '../common/sanitize.js';
import {
  dependencyInstallationPaths,
  synchronizeDependencies,
} from '../git/dependencies.js';
import { runGit } from '../git/git.js';
import {
  type StorageAction,
  type StorageActionResult,
  type StorageActionStatus,
} from './storage-maintenance.types.js';

export interface StorageCleanupConfig {
  dependencyCacheDir: string;
  dependencyStateFile: string;
  reposDir: string;
  temporaryDir: string;
  timeoutMs: number;
  repositorySyncTimeoutMs: number;
  environment: Readonly<Record<string, string | undefined>>;
}

export interface StorageCleanupDependencies {
  runProcess: typeof runProcess;
  runGit: typeof runGit;
  remove: (target: string) => Promise<void>;
  synchronizeDependencies: typeof synchronizeDependencies;
  isWorktreeSafeToRemove: (directory: string) => Promise<boolean>;
}

export async function executeStorageActions(
  actions: readonly StorageAction[],
  config: StorageCleanupConfig,
  overrides: Partial<StorageCleanupDependencies> = {},
): Promise<StorageActionResult[]> {
  const runGitAdapter = overrides.runGit ?? runGit;
  const dependencies: StorageCleanupDependencies = {
    runProcess: overrides.runProcess ?? runProcess,
    runGit: runGitAdapter,
    remove:
      overrides.remove ??
      ((target) => rm(target, { recursive: true, force: true })),
    synchronizeDependencies:
      overrides.synchronizeDependencies ?? synchronizeDependencies,
    isWorktreeSafeToRemove:
      overrides.isWorktreeSafeToRemove ??
      ((directory) => worktreeSafeToRemove(directory, config, runGitAdapter)),
  };

  const results: StorageActionResult[] = [];
  for (const action of actions) {
    const startedAt = Date.now();
    try {
      const status = await executeAction(action, config, dependencies);
      results.push({ action, status, durationMs: Date.now() - startedAt });
    } catch (error) {
      results.push({
        action,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: sanitize(error instanceof Error ? error.message : error),
      });
    }
  }
  return results;
}

async function executeAction(
  action: StorageAction,
  config: StorageCleanupConfig,
  dependencies: StorageCleanupDependencies,
): Promise<StorageActionStatus> {
  switch (action.type) {
    case 'prune-dependency-caches':
      await pruneDependencyCaches(config, dependencies.runProcess);
      return 'completed';
    case 'git-gc':
      assertWithin(action.repository, config.reposDir, 'repository');
      await dependencies.runGit(
        { repositorySyncTimeoutMs: config.repositorySyncTimeoutMs },
        action.repository,
        ['gc', '--auto'],
      );
      return 'completed';
    case 'remove-orphan-worktree':
      assertAgentWorktree(action.directory, config.temporaryDir);
      if (!(await dependencies.isWorktreeSafeToRemove(action.directory)))
        return 'skipped';
      await dependencies.remove(action.directory);
      return 'completed';
    case 'coordinated-dependency-reset':
      await coordinatedDependencyReset(config, dependencies);
      return 'completed';
  }
}

async function pruneDependencyCaches(
  config: StorageCleanupConfig,
  execute: typeof runProcess,
): Promise<void> {
  await runChecked(
    execute,
    'npm',
    ['cache', 'clean', '--force'],
    {
      ...config.environment,
      npm_config_cache: path.join(config.dependencyCacheDir, 'npm'),
    },
    config.timeoutMs,
    'npm cache clean',
  );
  await runChecked(
    execute,
    'pnpm',
    [
      'store',
      'prune',
      `--store-dir=${path.join(config.dependencyCacheDir, 'pnpm')}`,
    ],
    config.environment,
    config.timeoutMs,
    'pnpm store prune',
  );
  await runChecked(
    execute,
    'go',
    ['clean', '-cache', '-modcache'],
    {
      ...config.environment,
      GOCACHE: path.join(config.dependencyCacheDir, 'go-build'),
      GOMODCACHE: path.join(config.dependencyCacheDir, 'go-mod'),
    },
    config.timeoutMs,
    'go clean',
  );
}

async function runChecked(
  execute: typeof runProcess,
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const result = await execute(command, args, {
    env: environment,
    timeoutMs,
  });
  if (result.exitCode === 0) return;
  const detail = sanitize(
    result.stderr ||
      result.stdout ||
      `terminated by ${result.signal || 'unknown signal'}`,
  );
  throw new Error(`${label} failed: ${detail.trim().slice(-2000)}`);
}

async function coordinatedDependencyReset(
  config: StorageCleanupConfig,
  dependencies: StorageCleanupDependencies,
): Promise<void> {
  const installationPaths = dependencyInstallationPaths(
    config.reposDir,
    config.dependencyCacheDir,
  );
  const targets = [
    config.dependencyCacheDir,
    config.dependencyStateFile,
    ...installationPaths,
  ];
  for (const target of targets) await dependencies.remove(target);

  await dependencies.synchronizeDependencies(
    {
      enabled: true,
      reposDir: config.reposDir,
      timeoutMs: config.timeoutMs,
      repositorySyncTimeoutMs: config.repositorySyncTimeoutMs,
      cacheDir: config.dependencyCacheDir,
      stateFile: config.dependencyStateFile,
    },
    () => undefined,
  );
}

async function worktreeSafeToRemove(
  directory: string,
  config: StorageCleanupConfig,
  executeGit: typeof runGit,
): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length === 0 || entries.some((entry) => !entry.isDirectory()))
    return false;

  for (const entry of entries) {
    const repository = path.join(directory, entry.name);
    const gitFile = path.join(repository, '.git');
    if (!(await lstat(gitFile)).isFile()) return false;
    if (!(await readFile(gitFile, 'utf8')).startsWith('gitdir: ')) return false;

    const gitConfig = {
      repositorySyncTimeoutMs: config.repositorySyncTimeoutMs,
    };
    const commonDir = await executeGit(gitConfig, repository, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    if (
      path.basename(commonDir) !== '.git' ||
      !isWithin(path.dirname(commonDir), config.reposDir)
    )
      return false;
    if (
      await executeGit(gitConfig, repository, [
        'status',
        '--porcelain',
        '--untracked-files=all',
      ])
    )
      return false;
    const unmerged = await executeGit(gitConfig, repository, [
      'rev-list',
      '--count',
      'origin/main..HEAD',
    ]);
    if (unmerged !== '0') return false;
  }
  return true;
}

function assertAgentWorktree(directory: string, temporaryDir: string): void {
  const resolved = path.resolve(directory);
  if (
    !path.isAbsolute(directory) ||
    path.dirname(resolved) !== path.resolve(temporaryDir) ||
    !path.basename(resolved).startsWith('driva-remediation-')
  ) {
    throw new Error(`Refusing non-agent worktree removal: ${directory}`);
  }
}

function assertWithin(target: string, root: string, label: string): void {
  if (!isWithin(target, root))
    throw new Error(`Refusing ${label} outside ${root}: ${target}`);
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
  );
}
