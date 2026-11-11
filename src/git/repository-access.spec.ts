import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireOwnedLock,
  inspectOwnedLock,
  type OwnedLockOwner,
} from '../state/owned-lock.js';
import {
  acquireExclusiveRepositoryAccess,
  RepositoryAccessConflictError,
  withRepositoryAccess,
} from './repository-access.js';

function owner(instanceId: string): OwnedLockOwner {
  const timestamp = new Date().toISOString();
  return { instanceId, pid: 42, startedAt: timestamp, heartbeatAt: timestamp };
}

describe('repository access', () => {
  let root: string;
  let stateDir: string;
  let reposDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'repository-access-'));
    stateDir = path.join(root, 'state');
    reposDir = path.join(root, 'repos');
    await mkdir(reposDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function setup() {
    const calls: string[] = [];
    const dependencies = {
      synchronizeRepositories: vi.fn(
        async () => void calls.push('repositories'),
      ),
      syncDependencies: vi.fn(async () => void calls.push('dependencies')),
      materializeDiagnosisEnvFiles: vi.fn(
        async () => void calls.push('environment'),
      ),
      repositoryHeads: vi.fn(async () => ({ app: 'abc123' })),
    };
    const config = {
      reposDir,
      repositorySyncIgnore: [] as string[],
      repositorySyncTimeoutMs: 100,
      dependencySyncTimeoutMs: 200,
      dependencySyncEnabled: true,
    };
    return { calls, dependencies, config };
  }

  it('synchronizes in order when there are no live readers', async () => {
    const { calls, dependencies, config } = setup();
    let received: unknown;

    await withRepositoryAccess(
      config,
      { stateDir, owner: owner('one'), dependencies },
      async (syncInfo) => {
        received = syncInfo;
        const readers = await readdir(path.join(stateDir, 'repo-readers'));
        expect(readers).toHaveLength(1);
      },
    );

    expect(calls).toEqual(['repositories', 'dependencies', 'environment']);
    expect(received).toEqual({ status: 'synced', heads: { app: 'abc123' } });
  });

  it('skips synchronization when a live reader exists', async () => {
    const { calls, dependencies, config } = setup();
    const readerDir = path.join(stateDir, 'repo-readers', 'existing');
    await mkdir(path.dirname(readerDir), { recursive: true });
    const existing = await acquireOwnedLock({
      directory: readerDir,
      owner: owner('reader'),
    });

    let received: unknown;
    await withRepositoryAccess(
      config,
      { stateDir, owner: owner('two'), dependencies },
      async (syncInfo) => {
        received = syncInfo;
      },
    );

    expect(calls).toEqual([]);
    expect(received).toEqual({ status: 'skipped', heads: { app: 'abc123' } });
    await existing.release();
  });

  it('reclaims expired readers and an expired sync lock', async () => {
    const { calls, dependencies, config } = setup();
    let current = new Date('2026-01-01T00:00:00.000Z');
    const expired = owner('old');
    expired.heartbeatAt = current.toISOString();
    const readerDir = path.join(stateDir, 'repo-readers', 'expired');
    const syncDir = path.join(stateDir, 'repo-sync.lock');
    await mkdir(path.dirname(readerDir), { recursive: true });
    const expiredReader = await acquireOwnedLock({
      directory: readerDir,
      owner: expired,
      now: () => current,
    });
    const expiredSync = await acquireOwnedLock({
      directory: syncDir,
      owner: expired,
      now: () => current,
    });
    current = new Date(current.getTime() + 121_000);

    await withRepositoryAccess(
      config,
      {
        stateDir,
        owner: owner('new'),
        dependencies,
        now: () => current,
        leaseMs: 120_000,
      },
      async () => undefined,
    );

    expect(calls).toEqual(['repositories', 'dependencies', 'environment']);
    const stateEntries = await readdir(stateDir);
    expect(
      stateEntries.some((entry) => entry.startsWith('repo-sync.lock.stale-')),
    ).toBe(true);
    await expiredReader.release();
    await expiredSync.release();
  });

  it('fails dependency-only sync while repositories have live readers', async () => {
    const { dependencies, config } = setup();
    const readerDir = path.join(stateDir, 'repo-readers', 'existing');
    await mkdir(path.dirname(readerDir), { recursive: true });
    const existing = await acquireOwnedLock({
      directory: readerDir,
      owner: owner('reader'),
    });

    await expect(
      withRepositoryAccess(
        config,
        { stateDir, owner: owner('sync'), dependencies, syncOnly: true },
        async () => undefined,
      ),
    ).rejects.toThrow('Repositories are in use by 1 execution(s)');
    await existing.release();
  });

  it('holds exclusive repository access until explicitly released', async () => {
    const release = await acquireExclusiveRepositoryAccess({
      stateDir,
      owner: owner('maintenance'),
    });

    expect(await inspectOwnedLock(path.join(stateDir, 'repo-sync.lock'))).toBe(
      'live',
    );
    await release();
    expect(await inspectOwnedLock(path.join(stateDir, 'repo-sync.lock'))).toBe(
      'released',
    );
  });

  it('rejects exclusive access while a repository reader is live', async () => {
    const readerDir = path.join(stateDir, 'repo-readers', 'existing');
    await mkdir(path.dirname(readerDir), { recursive: true });
    const existing = await acquireOwnedLock({
      directory: readerDir,
      owner: owner('reader'),
    });

    await expect(
      acquireExclusiveRepositoryAccess({
        stateDir,
        owner: owner('maintenance'),
      }),
    ).rejects.toBeInstanceOf(RepositoryAccessConflictError);
    await existing.release();
  });

  it('times out waiting for a live synchronization owner', async () => {
    const { dependencies, config } = setup();
    const syncDir = path.join(stateDir, 'repo-sync.lock');
    const existing = await acquireOwnedLock({
      directory: syncDir,
      owner: owner('sync'),
    });
    const times = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.301Z'),
    ];

    await expect(
      withRepositoryAccess(
        config,
        {
          stateDir,
          owner: owner('waiter'),
          dependencies,
          now: () => times.shift() ?? times.at(-1) ?? new Date(),
          waitTimeoutMs: 300,
          pollIntervalMs: 300,
          sleep: async () => undefined,
        },
        async () => undefined,
      ),
    ).rejects.toThrow('Timed out acquiring owned lock');
    await existing.release();
  });
});
