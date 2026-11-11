import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { findGitRepositories } from '../git/git.js';
import { type StorageInventory } from './storage-maintenance.types.js';

export interface StorageInventoryConfig {
  stateDir: string;
  dependencyCacheDir: string;
  reposDir: string;
  temporaryDir: string;
  worktreeMinAgeMs: number;
}

export async function inventoryStorage(
  config: StorageInventoryConfig,
): Promise<StorageInventory> {
  const cacheBytesByKind = {
    npm: await directoryBytes(path.join(config.dependencyCacheDir, 'npm')),
    pnpm: await directoryBytes(path.join(config.dependencyCacheDir, 'pnpm')),
    goBuild: await directoryBytes(
      path.join(config.dependencyCacheDir, 'go-build'),
    ),
    goMod: await directoryBytes(path.join(config.dependencyCacheDir, 'go-mod')),
  };

  return {
    authoritativeStateBytes: await authoritativeStateBytes(config.stateDir),
    dependencyCacheBytes: await directoryBytes(config.dependencyCacheDir),
    cacheBytesByKind,
    repositories: await repositoryInventory(config.reposDir),
    orphanWorktrees: await orphanWorktreeInventory(config),
  };
}

async function authoritativeStateBytes(stateDir: string): Promise<number> {
  const entries = await directoryEntries(stateDir);
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    total += await fileBytes(path.join(stateDir, entry.name));
  }
  return total;
}

async function repositoryInventory(reposDir: string) {
  if (!(await pathExists(reposDir))) return [];
  const repositories = await findGitRepositories(reposDir, [], () => undefined);
  return Promise.all(
    repositories.map(async (directory) => ({
      name: path.relative(reposDir, directory) || '.',
      directory,
      totalBytes: await directoryBytes(directory),
      gitBytes: await directoryBytes(path.join(directory, '.git')),
      dependencyBytes: await dependencyBytes(directory),
    })),
  );
}

async function dependencyBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await directoryEntries(directory)) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const child = path.join(directory, entry.name);
    if (entry.name === 'node_modules') total += await directoryBytes(child);
    else total += await dependencyBytes(child);
  }
  return total;
}

async function orphanWorktreeInventory(config: StorageInventoryConfig) {
  const now = Date.now();
  const worktrees = [];
  for (const entry of await directoryEntries(config.temporaryDir)) {
    if (!entry.isDirectory() || !entry.name.startsWith('driva-remediation-'))
      continue;
    const directory = path.join(config.temporaryDir, entry.name);
    const metadata = await stat(directory);
    const ageMs = now - metadata.mtimeMs;
    if (ageMs < config.worktreeMinAgeMs) continue;
    worktrees.push({
      directory,
      ageMs,
      bytes: await directoryBytes(directory),
    });
  }
  return worktrees.sort((left, right) =>
    left.directory.localeCompare(right.directory),
  );
}

async function directoryBytes(directory: string): Promise<number> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  if (metadata.isFile()) return metadata.size;
  if (!metadata.isDirectory()) return 0;

  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    total += await directoryBytes(path.join(directory, entry.name));
  }
  return total;
}

async function fileBytes(filename: string): Promise<number> {
  return (await stat(filename)).size;
}

async function directoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
