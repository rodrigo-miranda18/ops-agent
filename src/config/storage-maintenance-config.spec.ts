import { describe, expect, it } from 'vitest';
import { storageMaintenanceConfig } from './storage-maintenance-config.js';

const MIB = 1024 * 1024;

describe('storageMaintenanceConfig', () => {
  it('defaults to disabled automation without calibrated limits', () => {
    expect(storageMaintenanceConfig({})).toEqual({
      enabled: false,
      cron: '43 3 * * *',
      dependencyCacheHighBytes: undefined,
      dependencyCacheTargetBytes: undefined,
      worktreeMinAgeMs: 24 * 60 * 60 * 1000,
      timeoutMs: 90 * 60 * 1000,
    });
  });

  it('parses enabled automation and converts configured units', () => {
    expect(
      storageMaintenanceConfig({
        STORAGE_MAINTENANCE_ENABLED: 'true',
        STORAGE_MAINTENANCE_CRON: '17 4 * * *',
        STORAGE_DEPENDENCY_CACHE_HIGH_MB: '2048',
        STORAGE_DEPENDENCY_CACHE_TARGET_MB: '1024',
        STORAGE_WORKTREE_MIN_AGE_HOURS: '48',
        STORAGE_MAINTENANCE_TIMEOUT_MINUTES: '120',
      }),
    ).toEqual({
      enabled: true,
      cron: '17 4 * * *',
      dependencyCacheHighBytes: 2048 * MIB,
      dependencyCacheTargetBytes: 1024 * MIB,
      worktreeMinAgeMs: 48 * 60 * 60 * 1000,
      timeoutMs: 120 * 60 * 1000,
    });
  });

  it('requires calibrated limits only when automation is enabled', () => {
    expect(() =>
      storageMaintenanceConfig({ STORAGE_MAINTENANCE_ENABLED: 'true' }),
    ).toThrow('STORAGE_DEPENDENCY_CACHE_HIGH_MB is required');

    expect(() =>
      storageMaintenanceConfig({
        STORAGE_MAINTENANCE_ENABLED: 'true',
        STORAGE_DEPENDENCY_CACHE_HIGH_MB: '2048',
      }),
    ).toThrow('STORAGE_DEPENDENCY_CACHE_TARGET_MB is required');
  });

  it.each([
    ['100', '100'],
    ['100', '101'],
  ])('requires target %s to be lower than high %s', (high, target) => {
    expect(() =>
      storageMaintenanceConfig({
        STORAGE_DEPENDENCY_CACHE_HIGH_MB: high,
        STORAGE_DEPENDENCY_CACHE_TARGET_MB: target,
      }),
    ).toThrow(
      'STORAGE_DEPENDENCY_CACHE_TARGET_MB must be lower than STORAGE_DEPENDENCY_CACHE_HIGH_MB',
    );
  });

  it('rejects invalid cron expressions', () => {
    expect(() =>
      storageMaintenanceConfig({ STORAGE_MAINTENANCE_CRON: 'daily' }),
    ).toThrow('STORAGE_MAINTENANCE_CRON is not a valid cron expression: daily');
  });

  it('rejects enabled values outside true or false', () => {
    expect(() =>
      storageMaintenanceConfig({ STORAGE_MAINTENANCE_ENABLED: 'yes' }),
    ).toThrow(
      'STORAGE_MAINTENANCE_ENABLED must be true or false, received: yes',
    );
  });

  it.each([
    'STORAGE_DEPENDENCY_CACHE_HIGH_MB',
    'STORAGE_DEPENDENCY_CACHE_TARGET_MB',
    'STORAGE_WORKTREE_MIN_AGE_HOURS',
    'STORAGE_MAINTENANCE_TIMEOUT_MINUTES',
  ])('rejects non-positive %s', (name) => {
    expect(() => storageMaintenanceConfig({ [name]: '0' })).toThrow(
      `${name} must be a positive integer, received: 0`,
    );
  });
});
