import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { communicationConfigFromEnv } from '../config/communication-config.js';
import { runtimeConfig } from '../config/runtime-config.js';
import type { CommunicationVersionEvents } from './communication-events.js';
import {
  CommunicationExecutionService,
  STALE_GENERATION_ERROR,
} from './communication-execution.service.js';
import type { CommunicationStore } from './communication-store.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
}

function setup(env: Record<string, string> = {}) {
  const children: FakeChild[] = [];
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const events = {
    versionReady: vi.fn<CommunicationVersionEvents['versionReady']>(() =>
      Promise.resolve(),
    ),
    versionFailed: vi.fn<CommunicationVersionEvents['versionFailed']>(() =>
      Promise.resolve(),
    ),
  };
  const store = {
    failStaleGenerations: vi.fn(() =>
      Promise.resolve([
        {
          id: 'c1',
          version: 2,
          space: 'spaces/dm',
          threadName: 'spaces/dm/threads/t',
        },
      ]),
    ),
  };
  const service = new CommunicationExecutionService(
    store as unknown as CommunicationStore,
    events,
    runtimeConfig({}, '/app'),
    communicationConfigFromEnv(env),
  );
  return { children, events, store, service };
}

describe('CommunicationExecutionService', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns the runner with IPC and reports a ready version', async () => {
    const { children, events, service } = setup();
    await service.start({ communicationId: 'c1', version: 1 });

    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { stdio: unknown[]; cwd: string },
    ];
    expect(command).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['--communication-id=c1', '--version=1']);
    expect(options.stdio).toEqual(['ignore', 'inherit', 'inherit', 'ipc']);
    expect(options.cwd).toBe('/app');

    children[0]?.emit('message', {
      type: 'communication-ready',
      communicationId: 'c1',
      version: 1,
    });
    children[0]?.emit('close', 0, null);
    await vi.waitFor(() =>
      expect(events.versionReady).toHaveBeenCalledWith({
        communicationId: 'c1',
        version: 1,
      }),
    );
    expect(events.versionFailed).not.toHaveBeenCalled();
  });

  it('forwards a failure message once', async () => {
    const { children, events, service } = setup();
    await service.start({ communicationId: 'c1', version: 1 });
    children[0]?.emit('message', {
      type: 'communication-failed',
      communicationId: 'c1',
      version: 1,
      error: 'Codex exited',
    });
    children[0]?.emit('close', 1, null);
    await vi.waitFor(() => expect(events.versionFailed).toHaveBeenCalled());
    expect(events.versionFailed).toHaveBeenCalledTimes(1);
    expect(events.versionFailed).toHaveBeenCalledWith({
      communicationId: 'c1',
      version: 1,
      error: 'Codex exited',
    });
  });

  it('treats an exit without a message as failed', async () => {
    const { children, events, service } = setup();
    await service.start({ communicationId: 'c1', version: 3 });
    children[0]?.emit('close', 1, null);
    await vi.waitFor(() =>
      expect(events.versionFailed).toHaveBeenCalledWith({
        communicationId: 'c1',
        version: 3,
        error: expect.stringContaining('exited without a result') as string,
      }),
    );
    expect(events.versionReady).not.toHaveBeenCalled();
  });

  it('kills the runner on timeout and reports failure', async () => {
    vi.useFakeTimers();
    const { children, events, service } = setup({
      COMMUNICATION_TIMEOUT_MINUTES: '1',
    });
    await service.start({ communicationId: 'c1', version: 1 });
    vi.advanceTimersByTime(60_000);
    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    children[0]?.emit('close', null, 'SIGTERM');
    await vi.waitFor(() =>
      expect(events.versionFailed).toHaveBeenCalledWith({
        communicationId: 'c1',
        version: 1,
        error: expect.stringContaining('timed out') as string,
      }),
    );
  });

  it('runs at most two generations at a time', async () => {
    const { children, service } = setup();
    await service.start({ communicationId: 'a', version: 1 });
    await service.start({ communicationId: 'b', version: 1 });
    await service.start({ communicationId: 'c', version: 1 });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    children[0]?.emit('close', 0, null);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(3));
    expect(spawnMock.mock.calls[2]?.[1]).toContain('--communication-id=c');
  });

  it('fails stale generations on boot and notifies the thread', async () => {
    const { events, store, service } = setup();
    service.onApplicationBootstrap();
    await vi.waitFor(() =>
      expect(events.versionFailed).toHaveBeenCalledWith({
        communicationId: 'c1',
        version: 2,
        error: STALE_GENERATION_ERROR,
      }),
    );
    expect(store.failStaleGenerations).toHaveBeenCalledTimes(1);
  });

  it('kills running children on shutdown', async () => {
    const { children, service } = setup();
    await service.start({ communicationId: 'c1', version: 1 });
    service.onApplicationShutdown();
    expect(children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
