import { Logger } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { StalePullRequestCleanupService } from './stale-pull-request-cleanup.service.js';
import { StalePullRequestScheduler } from './stale-pull-request.scheduler.js';

describe('StalePullRequestScheduler', () => {
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  const build = (cleanup: () => Promise<unknown>, enabled = true) =>
    new StalePullRequestScheduler(
      { cleanup } as unknown as StalePullRequestCleanupService,
      {} as SchedulerRegistry,
      { stalePrCleanupEnabled: enabled } as AppConfig,
    );

  it('does not run when disabled', async () => {
    const cleanup = vi.fn();
    await build(cleanup, false).execute();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous run is in flight', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const cleanup = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const scheduler = build(cleanup);

    const first = scheduler.execute();
    await scheduler.execute();
    finish({
      checked: 0,
      closed: [],
      issuesChecked: 0,
      issuesClosed: [],
      failed: 0,
    });
    await first;

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('logs failures without throwing and allows the next run', async () => {
    const cleanup = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        checked: 0,
        closed: [],
        issuesChecked: 0,
        issuesClosed: [],
        failed: 0,
      });
    const scheduler = build(cleanup);

    await expect(scheduler.execute()).resolves.toBeUndefined();
    await scheduler.execute();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
