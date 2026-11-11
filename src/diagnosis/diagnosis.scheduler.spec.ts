import { Logger } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { DiagnosisExecutionService } from './diagnosis-execution.service.js';
import { DiagnosisScheduler } from './diagnosis.scheduler.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createScheduler(enabled = true) {
  const enqueue = vi.fn();
  const executions = { enqueue } as unknown as DiagnosisExecutionService;
  const config = {
    diagnosisCron: '* * * * *',
    diagnosisCronEnabled: enabled,
  } as AppConfig;
  const scheduler = new DiagnosisScheduler(
    executions,
    {} as SchedulerRegistry,
    config,
  );
  return { scheduler, enqueue };
}

describe('DiagnosisScheduler', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('skips ticks while the previous cron run is in flight', async () => {
    const { scheduler, enqueue } = createScheduler();
    const run = deferred();
    enqueue.mockResolvedValue({ runId: 'run-1', completion: run.promise });

    const first = scheduler.execute();
    await scheduler.execute();
    await scheduler.execute();
    expect(enqueue).toHaveBeenCalledTimes(1);

    run.resolve();
    await first;
    await scheduler.execute();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('enqueues again after a failed cron run', async () => {
    const { scheduler, enqueue } = createScheduler();
    const run = deferred();
    enqueue.mockResolvedValueOnce({
      runId: 'run-1',
      completion: run.promise,
    });

    const first = scheduler.execute();
    run.reject(new Error('runner exited with code 1'));
    await first;

    enqueue.mockResolvedValueOnce({
      runId: 'run-2',
      completion: Promise.resolve(),
    });
    await scheduler.execute();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('enqueues again after enqueue itself fails', async () => {
    const { scheduler, enqueue } = createScheduler();
    enqueue.mockRejectedValueOnce(new Error('state write failed'));
    await scheduler.execute();

    enqueue.mockResolvedValueOnce({
      runId: 'run-2',
      completion: Promise.resolve(),
    });
    await scheduler.execute();
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the cron is disabled', async () => {
    const { scheduler, enqueue } = createScheduler(false);
    await scheduler.execute();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
