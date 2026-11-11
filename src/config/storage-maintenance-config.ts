import { validateCronExpression } from 'cron';
import { type Environment } from './env.js';

export const STORAGE_MAINTENANCE_CONFIG = Symbol('STORAGE_MAINTENANCE_CONFIG');

export interface StorageMaintenanceConfig {
  enabled: boolean;
  cron: string;
  dependencyCacheHighBytes?: number;
  dependencyCacheTargetBytes?: number;
  worktreeMinAgeMs: number;
  timeoutMs: number;
}

const DEFAULT_CRON = '43 3 * * *';
const DEFAULT_WORKTREE_MIN_AGE_HOURS = 24;
const DEFAULT_TIMEOUT_MINUTES = 90;
const MIB = 1024 * 1024;

export function storageMaintenanceConfig(
  env: Environment = process.env,
): StorageMaintenanceConfig {
  const enabled = parseBoolean(env.STORAGE_MAINTENANCE_ENABLED);
  const cron = env.STORAGE_MAINTENANCE_CRON || DEFAULT_CRON;
  if (!validateCronExpression(cron).valid) {
    throw new Error(
      `STORAGE_MAINTENANCE_CRON is not a valid cron expression: ${cron}`,
    );
  }

  const dependencyCacheHighMb = parseOptionalPositiveInteger(
    env.STORAGE_DEPENDENCY_CACHE_HIGH_MB,
    'STORAGE_DEPENDENCY_CACHE_HIGH_MB',
  );
  const dependencyCacheTargetMb = parseOptionalPositiveInteger(
    env.STORAGE_DEPENDENCY_CACHE_TARGET_MB,
    'STORAGE_DEPENDENCY_CACHE_TARGET_MB',
  );

  if (enabled && dependencyCacheHighMb === undefined) {
    throw new Error('STORAGE_DEPENDENCY_CACHE_HIGH_MB is required');
  }
  if (enabled && dependencyCacheTargetMb === undefined) {
    throw new Error('STORAGE_DEPENDENCY_CACHE_TARGET_MB is required');
  }
  if (
    dependencyCacheHighMb !== undefined &&
    dependencyCacheTargetMb !== undefined &&
    dependencyCacheTargetMb >= dependencyCacheHighMb
  ) {
    throw new Error(
      'STORAGE_DEPENDENCY_CACHE_TARGET_MB must be lower than STORAGE_DEPENDENCY_CACHE_HIGH_MB',
    );
  }

  return {
    enabled,
    cron,
    dependencyCacheHighBytes:
      dependencyCacheHighMb === undefined
        ? undefined
        : dependencyCacheHighMb * MIB,
    dependencyCacheTargetBytes:
      dependencyCacheTargetMb === undefined
        ? undefined
        : dependencyCacheTargetMb * MIB,
    worktreeMinAgeMs:
      parsePositiveInteger(
        env.STORAGE_WORKTREE_MIN_AGE_HOURS,
        'STORAGE_WORKTREE_MIN_AGE_HOURS',
        DEFAULT_WORKTREE_MIN_AGE_HOURS,
      ) *
      60 *
      60 *
      1000,
    timeoutMs:
      parsePositiveInteger(
        env.STORAGE_MAINTENANCE_TIMEOUT_MINUTES,
        'STORAGE_MAINTENANCE_TIMEOUT_MINUTES',
        DEFAULT_TIMEOUT_MINUTES,
      ) *
      60 *
      1000,
  };
}

function parseBoolean(value: string | undefined): boolean {
  const resolved = value || 'false';
  if (resolved !== 'true' && resolved !== 'false') {
    throw new Error(
      `STORAGE_MAINTENANCE_ENABLED must be true or false, received: ${resolved}`,
    );
  }
  return resolved === 'true';
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (!value) return undefined;
  return parsePositiveInteger(value, name);
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  fallback?: number,
): number {
  const resolved = value || (fallback === undefined ? '' : String(fallback));
  if (!/^[1-9]\d*$/.test(resolved)) {
    throw new Error(
      `${name} must be a positive integer, received: ${resolved}`,
    );
  }
  return Number(resolved);
}
