import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RunnerConfig } from '../config/runner-config.js';
import {
  acquireOwnedLock,
  inspectOwnedLock,
  startOwnedLockHeartbeat,
  type OwnedLockOptions,
  type OwnedLockOwner,
} from '../state/owned-lock.js';
import { runnerLogger } from '../runner/runner-logger.js';
import {
  materializeDiagnosisEnvFiles,
  syncDependencies,
} from '../runner/runner-preparation.js';
import { findGitRepositories, runGit, synchronizeRepositories } from './git.js';

export interface RepositorySyncInfo {
  status: 'synced' | 'skipped';
  heads: Record<string, string>;
}

type RepositoryAccessConfig = Pick<
  RunnerConfig,
  | 'reposDir'
  | 'repositorySyncIgnore'
  | 'repositorySyncTimeoutMs'
  | 'dependencySyncTimeoutMs'
  | 'dependencySyncEnabled'
>;

type RepositoryAccessDependencies = {
  synchronizeRepositories: typeof synchronizeRepositories;
  syncDependencies: typeof syncDependencies;
  materializeDiagnosisEnvFiles: typeof materializeDiagnosisEnvFiles;
  repositoryHeads: (
    config: RepositoryAccessConfig,
  ) => Promise<Record<string, string>>;
};

export class RepositoryAccessConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RepositoryAccessConflictError';
  }
}

type RepositoryAccessOptions = {
  stateDir: string;
  owner: OwnedLockOwner;
  syncOnly?: boolean;
  dependencies?: RepositoryAccessDependencies;
  log?: (message: string) => void;
  waitTimeoutMs?: number;
} & Pick<OwnedLockOptions, 'leaseMs' | 'pollIntervalMs' | 'now' | 'sleep'>;

const defaultDependencies: RepositoryAccessDependencies = {
  synchronizeRepositories,
  syncDependencies,
  materializeDiagnosisEnvFiles,
  repositoryHeads,
};

function safeOwnerName(owner: OwnedLockOwner): string {
  const identity = owner.instanceId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${identity}-${owner.pid}-${randomUUID()}`;
}

async function repositoryHeads(
  config: RepositoryAccessConfig,
): Promise<Record<string, string>> {
  const repositories = await findGitRepositories(
    config.reposDir,
    config.repositorySyncIgnore,
    (message) => runnerLogger.info(message),
  );
  const heads: Record<string, string> = {};
  for (const repository of repositories) {
    heads[path.relative(config.reposDir, repository)] = await runGit(
      config,
      repository,
      ['rev-parse', 'HEAD'],
    );
  }
  return heads;
}

async function liveReaderCount(
  readersDir: string,
  options: Pick<RepositoryAccessOptions, 'leaseMs' | 'now'>,
): Promise<number> {
  await mkdir(readersDir, { recursive: true });
  const entries = await readdir(readersDir, { withFileTypes: true });
  let live = 0;
  const now = options.now?.() ?? new Date();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes('.stale-')) continue;
    const directory = path.join(readersDir, entry.name);
    const status = await inspectOwnedLock(directory, {
      leaseMs: options.leaseMs,
      now,
    });
    if (status === 'live') {
      live += 1;
      continue;
    }
    if (status === 'released') {
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    if (status === 'expired') {
      try {
        await rename(directory, `${directory}.stale-${now.toISOString()}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return live;
}

export async function acquireExclusiveRepositoryAccess(
  options: Pick<
    RepositoryAccessOptions,
    'stateDir' | 'owner' | 'leaseMs' | 'pollIntervalMs' | 'now' | 'sleep'
  >,
): Promise<() => Promise<void>> {
  let lock;
  try {
    lock = await acquireOwnedLock({
      directory: path.join(options.stateDir, 'repo-sync.lock'),
      owner: options.owner,
      leaseMs: options.leaseMs,
      waitTimeoutMs: 0,
      pollIntervalMs: options.pollIntervalMs,
      now: options.now,
      sleep: options.sleep,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Timed out acquiring owned lock:')
    )
      throw new RepositoryAccessConflictError(
        'Repository maintenance is already in progress',
        { cause: error },
      );
    throw error;
  }

  const stopHeartbeat = startOwnedLockHeartbeat(lock);
  try {
    const readers = await liveReaderCount(
      path.join(options.stateDir, 'repo-readers'),
      options,
    );
    if (readers > 0)
      throw new RepositoryAccessConflictError(
        `Repositories are in use by ${readers} execution(s)`,
      );
  } catch (error) {
    await stopHeartbeat();
    await lock.release();
    throw error;
  }

  return async () => {
    await stopHeartbeat();
    await lock.release();
  };
}

export async function withRepositoryAccess<T>(
  config: RepositoryAccessConfig,
  options: RepositoryAccessOptions,
  run: (syncInfo: RepositorySyncInfo) => Promise<T>,
): Promise<T> {
  const dependencies = options.dependencies ?? defaultDependencies;
  const log = options.log ?? ((message: string) => runnerLogger.info(message));
  const readersDir = path.join(options.stateDir, 'repo-readers');
  const syncLock = await acquireOwnedLock({
    directory: path.join(options.stateDir, 'repo-sync.lock'),
    owner: options.owner,
    leaseMs: options.leaseMs,
    waitTimeoutMs:
      options.waitTimeoutMs ??
      config.repositorySyncTimeoutMs + config.dependencySyncTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    now: options.now,
    sleep: options.sleep,
  });

  const stopSyncHeartbeat = startOwnedLockHeartbeat(syncLock);
  const prepared = await (async () => {
    try {
      const readers = await liveReaderCount(readersDir, options);
      if (options.syncOnly && readers > 0)
        throw new Error(`Repositories are in use by ${readers} execution(s)`);

      const status: RepositorySyncInfo['status'] =
        readers === 0 ? 'synced' : 'skipped';
      if (status === 'synced') {
        await dependencies.synchronizeRepositories(config, log);
        await dependencies.syncDependencies(config);
        await dependencies.materializeDiagnosisEnvFiles(config);
      }
      const syncInfo = {
        status,
        heads: await dependencies.repositoryHeads(config),
      } satisfies RepositorySyncInfo;
      if (status === 'skipped')
        log(
          `Repository synchronization skipped: ${readers} live reader(s); heads=${JSON.stringify(syncInfo.heads)}`,
        );

      const reader = options.syncOnly
        ? undefined
        : await acquireOwnedLock({
            directory: path.join(readersDir, safeOwnerName(options.owner)),
            owner: options.owner,
            leaseMs: options.leaseMs,
            waitTimeoutMs: 0,
            now: options.now,
          });
      return {
        reader,
        stopReaderHeartbeat: reader
          ? startOwnedLockHeartbeat(reader)
          : undefined,
        syncInfo,
      };
    } finally {
      await stopSyncHeartbeat();
      await syncLock.release();
    }
  })();

  try {
    return await run(prepared.syncInfo);
  } finally {
    await prepared.stopReaderHeartbeat?.();
    await prepared.reader?.release();
  }
}
