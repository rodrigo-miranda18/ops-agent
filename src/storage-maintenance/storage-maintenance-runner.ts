#!/usr/bin/env node

import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { appReposDir } from '../config/app-config.js';
import { DEPENDENCY_ENVIRONMENT, loadDotEnv, pickEnv } from '../config/env.js';
import {
  type StorageMaintenanceConfig,
  storageMaintenanceConfig,
} from '../config/storage-maintenance-config.js';
import {
  acquireExclusiveRepositoryAccess,
  RepositoryAccessConflictError,
} from '../git/repository-access.js';
import { releaseAllOwnedLocks } from '../state/owned-lock.js';
import { createInstanceId } from '../state/owner-identity.js';
import { runnerLogger, type RunnerLogger } from '../runner/runner-logger.js';
import {
  dependencyCacheDir,
  dependencyStateFile,
  projectDir,
  stateDir,
} from '../runner/runner-paths.js';
import {
  executeStorageActions,
  type StorageCleanupConfig,
} from './storage-cleanup.js';
import { inventoryStorage } from './storage-inventory.js';
import {
  type StorageAction,
  type StorageActionResult,
  type StorageInventory,
} from './storage-maintenance.types.js';
import { planStorageMaintenance } from './storage-policy.js';

export const STORAGE_MAINTENANCE_SKIPPED_EXIT_CODE = 75;
export const STORAGE_MAINTENANCE_TRIGGERS = ['manual', 'cron'] as const;
export type StorageMaintenanceTrigger =
  (typeof STORAGE_MAINTENANCE_TRIGGERS)[number];

export interface StorageMaintenanceArgs {
  execute: boolean;
  trigger: StorageMaintenanceTrigger;
}

export interface StorageMaintenanceReport {
  status: 'completed' | 'skipped' | 'failed';
  mode: 'dry-run' | 'execute';
  trigger: StorageMaintenanceTrigger;
  before?: StorageInventory;
  after?: StorageInventory;
  plannedActions: StorageAction[];
  actionResults: StorageActionResult[];
  bytesReclaimed: number;
  durationMs: number;
  error?: string;
}

export interface StorageMaintenanceRunnerDependencies {
  config: StorageMaintenanceConfig;
  acquireLock: (owner: string) => Promise<() => Promise<void>>;
  inventory: () => Promise<StorageInventory>;
  executeActions: (
    actions: readonly StorageAction[],
  ) => Promise<StorageActionResult[]>;
  logger: RunnerLogger;
}

export function parseStorageMaintenanceArgs(
  argv: readonly string[],
): StorageMaintenanceArgs {
  let execute = false;
  let explicitDryRun = false;
  let trigger: StorageMaintenanceTrigger = 'manual';

  for (const argument of argv) {
    if (argument === '--execute') execute = true;
    else if (argument === '--dry-run') explicitDryRun = true;
    else if (argument.startsWith('--trigger=')) {
      const value = argument.slice('--trigger='.length);
      if (value !== 'manual' && value !== 'cron')
        throw new Error(`Invalid storage maintenance trigger: ${value}`);
      trigger = value;
    } else throw new Error(`Unknown storage maintenance argument: ${argument}`);
  }
  if (execute && explicitDryRun)
    throw new Error('--dry-run and --execute are mutually exclusive');
  return { execute, trigger };
}

export async function runStorageMaintenance(
  args: StorageMaintenanceArgs,
  provided?: StorageMaintenanceRunnerDependencies,
): Promise<StorageMaintenanceReport> {
  const startedAt = Date.now();
  const mode = args.execute ? 'execute' : 'dry-run';
  const dependencies = provided ?? defaultDependencies();
  let releaseLock: (() => Promise<void>) | undefined;

  try {
    releaseLock = await dependencies.acquireLock('storage-maintenance');
  } catch (error) {
    if (!(error instanceof RepositoryAccessConflictError)) throw error;
    const report: StorageMaintenanceReport = {
      status: 'skipped',
      mode,
      trigger: args.trigger,
      plannedActions: [],
      actionResults: [],
      bytesReclaimed: 0,
      durationMs: Date.now() - startedAt,
      error: error.message,
    };
    dependencies.logger.warn(
      JSON.stringify({
        event: 'storage_maintenance_lock_conflict',
        mode,
        trigger: args.trigger,
        error: error.message,
      }),
    );
    logSummary(dependencies.logger, report);
    return report;
  }

  try {
    const before = await dependencies.inventory();
    logInventory(dependencies.logger, 'before', before, mode, args.trigger);
    const plannedActions = planStorageMaintenance({
      inventory: before,
      highBytes: dependencies.config.dependencyCacheHighBytes,
      targetBytes: dependencies.config.dependencyCacheTargetBytes,
      execute: args.execute,
    });
    dependencies.logger.info(
      JSON.stringify({
        event: 'storage_maintenance_plan',
        mode,
        trigger: args.trigger,
        actions: plannedActions,
      }),
    );

    if (!args.execute) {
      const report: StorageMaintenanceReport = {
        status: 'completed',
        mode,
        trigger: args.trigger,
        before,
        after: before,
        plannedActions,
        actionResults: [],
        bytesReclaimed: 0,
        durationMs: Date.now() - startedAt,
      };
      logSummary(dependencies.logger, report);
      return report;
    }

    const actionResults = await dependencies.executeActions(plannedActions);
    let after = await dependencies.inventory();
    const pruneCompleted = actionResults.some(
      ({ action, status }) =>
        action.type === 'prune-dependency-caches' && status === 'completed',
    );
    if (pruneCompleted) {
      const resetActions = planStorageMaintenance({
        inventory: after,
        highBytes: dependencies.config.dependencyCacheHighBytes,
        targetBytes: dependencies.config.dependencyCacheTargetBytes,
        execute: true,
        afterIncrementalCleanup: true,
      });
      if (resetActions.length) {
        plannedActions.push(...resetActions);
        actionResults.push(
          ...(await dependencies.executeActions(resetActions)),
        );
        after = await dependencies.inventory();
      }
    }
    logInventory(dependencies.logger, 'after', after, mode, args.trigger);
    for (const result of actionResults)
      dependencies.logger[result.status === 'failed' ? 'error' : 'info'](
        JSON.stringify({
          event: 'storage_maintenance_action',
          mode,
          trigger: args.trigger,
          ...result,
        }),
      );

    const report: StorageMaintenanceReport = {
      status: actionResults.some(({ status }) => status === 'failed')
        ? 'failed'
        : 'completed',
      mode,
      trigger: args.trigger,
      before,
      after,
      plannedActions,
      actionResults,
      bytesReclaimed: Math.max(0, measuredBytes(before) - measuredBytes(after)),
      durationMs: Date.now() - startedAt,
    };
    logSummary(dependencies.logger, report);
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const report: StorageMaintenanceReport = {
      status: 'failed',
      mode,
      trigger: args.trigger,
      plannedActions: [],
      actionResults: [],
      bytesReclaimed: 0,
      durationMs: Date.now() - startedAt,
      error: message,
    };
    dependencies.logger.error(
      JSON.stringify({
        event: 'storage_maintenance_failed',
        mode,
        trigger: args.trigger,
        error: message,
      }),
    );
    logSummary(dependencies.logger, report);
    return report;
  } finally {
    await releaseLock();
  }
}

function defaultDependencies(): StorageMaintenanceRunnerDependencies {
  const config = storageMaintenanceConfig();
  const reposDir = appReposDir();
  const cleanupConfig: StorageCleanupConfig = {
    dependencyCacheDir,
    dependencyStateFile,
    reposDir,
    temporaryDir: tmpdir(),
    timeoutMs: config.timeoutMs,
    repositorySyncTimeoutMs: config.timeoutMs,
    environment: pickEnv(DEPENDENCY_ENVIRONMENT),
  };
  const instanceId = createInstanceId('runner');
  return {
    config,
    acquireLock: () =>
      acquireExclusiveRepositoryAccess({
        stateDir,
        owner: {
          instanceId,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        },
      }),
    inventory: () =>
      inventoryStorage({
        stateDir,
        dependencyCacheDir,
        reposDir,
        temporaryDir: cleanupConfig.temporaryDir,
        worktreeMinAgeMs: config.worktreeMinAgeMs,
      }),
    executeActions: (actions) => executeStorageActions(actions, cleanupConfig),
    logger: runnerLogger,
  };
}

function measuredBytes(inventory: StorageInventory): number {
  return (
    inventory.authoritativeStateBytes +
    inventory.dependencyCacheBytes +
    inventory.repositories.reduce(
      (sum, repository) => sum + repository.totalBytes,
      0,
    ) +
    inventory.orphanWorktrees.reduce((sum, worktree) => sum + worktree.bytes, 0)
  );
}

function logInventory(
  logger: RunnerLogger,
  phase: 'before' | 'after',
  inventory: StorageInventory,
  mode: 'dry-run' | 'execute',
  trigger: StorageMaintenanceTrigger,
): void {
  logger.info(
    JSON.stringify({
      event: 'storage_maintenance_inventory',
      phase,
      mode,
      trigger,
      authoritativeStateBytes: inventory.authoritativeStateBytes,
      dependencyCacheBytes: inventory.dependencyCacheBytes,
      cacheBytesByKind: inventory.cacheBytesByKind,
      repositories: inventory.repositories,
      orphanWorktrees: inventory.orphanWorktrees,
    }),
  );
}

function logSummary(
  logger: RunnerLogger,
  report: StorageMaintenanceReport,
): void {
  logger[report.status === 'failed' ? 'error' : 'info'](
    JSON.stringify({
      event: 'storage_maintenance_summary',
      status: report.status,
      mode: report.mode,
      trigger: report.trigger,
      dependencyCacheBytesBefore: report.before?.dependencyCacheBytes,
      dependencyCacheBytesAfter: report.after?.dependencyCacheBytes,
      bytesReclaimed: report.bytesReclaimed,
      durationMs: report.durationMs,
      actionCount: report.plannedActions.length,
      error: report.error,
    }),
  );
}

async function main(): Promise<void> {
  await loadDotEnv(path.join(projectDir, '.env'));
  const report = await runStorageMaintenance(
    parseStorageMaintenanceArgs(process.argv.slice(2)),
  );
  if (report.status === 'failed') process.exitCode = 1;
  else if (report.status === 'skipped' && report.trigger === 'cron')
    process.exitCode = STORAGE_MAINTENANCE_SKIPPED_EXIT_CODE;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.once('SIGTERM', () => {
    void releaseAllOwnedLocks().finally(() => process.exit(143));
  });
  void main().catch((error: Error) => {
    runnerLogger.error(
      JSON.stringify({
        event: 'storage_maintenance_entrypoint_failed',
        error: error.message,
      }),
    );
    process.exitCode = 1;
  });
}
