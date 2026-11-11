import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { StorageMaintenanceConfig } from '../config/storage-maintenance-config.js';
import { StorageMaintenanceExecutionService } from './storage-maintenance-execution.service.js';
import { StorageMaintenanceScheduler } from './storage-maintenance.scheduler.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

class FakeChild extends EventEmitter {
  pid?: number;
  kill = vi.fn();
}

const config = (enabled = true): StorageMaintenanceConfig => ({
  enabled,
  cron: '43 3 * * *',
  dependencyCacheHighBytes: enabled ? 200 : undefined,
  dependencyCacheTargetBytes: enabled ? 100 : undefined,
  worktreeMinAgeMs: 24 * 60 * 60 * 1000,
  timeoutMs: 1000,
});

function createScheduler(enabled = true) {
  const execute = vi.fn();
  const executions = {
    execute,
  } as unknown as StorageMaintenanceExecutionService;
  const scheduler = new StorageMaintenanceScheduler(
    executions,
    {} as SchedulerRegistry,
    config(enabled),
  );
  return { scheduler, execute };
}

describe('StorageMaintenanceExecutionService', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
  });

  it('queues the maintenance child with inherited IO and cron arguments', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const runtime = {
      cwd: '/app',
      stateDir: '/app/state',
      processEnv: { PATH: '/bin' },
    } as RuntimeConfig;
    const service = new StorageMaintenanceExecutionService(runtime, config());

    const execution = service.execute('cron');
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv; stdio: string; detached: boolean },
    ];
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['--execute', '--trigger=cron']);
    expect(args[0]).toMatch(/storage-maintenance-runner\.js$/);
    expect(options).toEqual({
      cwd: '/app',
      env: runtime.processEnv,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });

    child.emit('close', 0);
    await expect(execution).resolves.toBe(0);
  });

  it('terminates a timed-out child and children still running at shutdown', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const service = new StorageMaintenanceExecutionService(
      { cwd: '/app', stateDir: '/app/state', processEnv: {} } as RuntimeConfig,
      config(),
    );

    const execution = service.execute('cron');
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const shutdown = service.onApplicationShutdown();
    let shutdownFinished = false;
    void shutdown.then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(2);

    child.emit('close', 1);
    await expect(execution).resolves.toBe(1);
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
});

describe('StorageMaintenanceScheduler', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('does nothing while automatic maintenance is disabled', async () => {
    const { scheduler, execute } = createScheduler(false);
    await scheduler.execute();
    expect(execute).not.toHaveBeenCalled();
    expect(Logger.prototype.debug).toHaveBeenCalledWith(
      'Storage maintenance cron is disabled',
    );
  });

  it('skips duplicate ticks while maintenance is in flight', async () => {
    const { scheduler, execute } = createScheduler();
    let finish!: (code: number) => void;
    execute.mockReturnValue(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );

    const first = scheduler.execute();
    await scheduler.execute();
    expect(execute).toHaveBeenCalledTimes(1);
    finish(0);
    await first;
    await scheduler.execute();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('logs non-zero exits and caught execution failures without throwing', async () => {
    const { scheduler, execute } = createScheduler();
    execute.mockResolvedValueOnce(1);
    await scheduler.execute();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('exited with code 1'),
    );

    execute.mockRejectedValueOnce(new Error('spawn failed'));
    await scheduler.execute();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('spawn failed'),
    );
  });

  it('treats the lock-conflict exit code as a safe skip', async () => {
    const { scheduler, execute } = createScheduler();
    execute.mockResolvedValue(75);

    await scheduler.execute();

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'skipped because another execution owns the lock',
      ),
    );
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });
});
