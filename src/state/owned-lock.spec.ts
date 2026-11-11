import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireOwnedLock,
  inspectOwnedLock,
  releaseAllOwnedLocks,
  startOwnedLockHeartbeat,
  type OwnedLockHandle,
  type OwnedLockOwner,
} from './owned-lock.js';

const startedAt = '2026-10-03T12:00:00.000Z';

function owner(instanceId: string, pid = 123): OwnedLockOwner {
  return { instanceId, pid, startedAt, heartbeatAt: startedAt };
}

function clock(initial = startedAt) {
  let time = new Date(initial).getTime();
  return {
    now: () => new Date(time),
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    sleep: async (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

describe('acquireOwnedLock', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'owned-lock-'));
    await rm(directory, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await releaseAllOwnedLocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('reclaims a normal release without retaining a stale audit directory', async () => {
    const time = clock();
    const lock = await acquireOwnedLock({
      directory,
      owner: owner('nest:a'),
      now: time.now,
    });

    expect(lock.owner.instanceId).toBe('nest:a');
    expect(lock.token).toEqual(expect.any(String));

    await lock.release();

    expect(
      JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')),
    ).toMatchObject({
      fencing_token: lock.token,
      released_at: startedAt,
    });

    const replacement = await acquireOwnedLock({
      directory,
      owner: owner('nest:b'),
      now: time.now,
    });

    expect(replacement.owner.instanceId).toBe('nest:b');
    await expect(stat(`${directory}.stale-${startedAt}`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('persists the owner with snake_case fields in a mode 0600 file', async () => {
    const lock = await acquireOwnedLock({
      directory,
      owner: owner('nest:a'),
      now: () => new Date(startedAt),
    });
    const ownerFile = path.join(directory, 'owner.json');

    expect(JSON.parse(await readFile(ownerFile, 'utf8'))).toMatchObject({
      instance_id: 'nest:a',
      pid: 123,
      started_at: startedAt,
      heartbeat_at: startedAt,
      fencing_token: lock.token,
    });
    expect((await stat(ownerFile)).mode & 0o777).toBe(0o600);
  });

  it('renews the heartbeat while preserving the acquisition token', async () => {
    const time = clock();
    const lock = await acquireOwnedLock({
      directory,
      owner: owner('nest:a'),
      now: time.now,
    });

    time.advance(1_000);
    await lock.heartbeat();

    expect(lock.owner.heartbeatAt).toBe('2026-10-03T12:00:01.000Z');
    expect(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'))).toMatchObject({
      heartbeat_at: '2026-10-03T12:00:01.000Z',
      fencing_token: lock.token,
    });
  });

  it('waits for a live owner until the timeout elapses', async () => {
    const time = clock();
    await acquireOwnedLock({ directory, owner: owner('nest:a'), now: time.now });

    await expect(
      acquireOwnedLock({
        directory,
        owner: owner('nest:b'),
        leaseMs: 1_000,
        waitTimeoutMs: 100,
        pollIntervalMs: 25,
        now: time.now,
        sleep: time.sleep,
      }),
    ).rejects.toThrow('Timed out acquiring owned lock');
    expect(time.now().toISOString()).toBe('2026-10-03T12:00:00.100Z');
  });

  it('keeps equal PIDs with distinct instance IDs as separate live owners', async () => {
    const time = clock();
    const first = await acquireOwnedLock({
      directory,
      owner: owner('container:a', 1),
      now: time.now,
    });

    await expect(
      acquireOwnedLock({
        directory,
        owner: owner('container:b', 1),
        waitTimeoutMs: 0,
        now: time.now,
      }),
    ).rejects.toThrow('Timed out acquiring owned lock');
    expect(first.owner.instanceId).toBe('container:a');
  });

  it('moves an expired lock directory aside before acquiring it', async () => {
    const time = clock('2026-10-03T12:00:02.000Z');
    await mkdir(directory);
    await writeFile(
      path.join(directory, 'owner.json'),
      JSON.stringify({
        instance_id: 'nest:dead',
        pid: 99,
        started_at: startedAt,
        heartbeat_at: startedAt,
        fencing_token: 'dead-token',
      }),
    );

    await acquireOwnedLock({
      directory,
      owner: owner('nest:new'),
      leaseMs: 1_000,
      now: time.now,
    });

    expect(await stat(`${directory}.stale-2026-10-03T12:00:02.000Z`)).toBeDefined();
    expect(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'))).toMatchObject({
      instance_id: 'nest:new',
    });
  });

  it.each(['missing', 'unreadable'])(
    'uses directory mtime when owner metadata is %s',
    async (state) => {
      const time = clock('2026-10-03T12:00:02.000Z');
      await mkdir(directory);
      if (state === 'unreadable') {
        await writeFile(path.join(directory, 'owner.json'), '{not json');
      }
      await utimes(directory, new Date(startedAt), new Date(startedAt));

      await acquireOwnedLock({
        directory,
        owner: owner('nest:new'),
        leaseMs: 1_000,
        now: time.now,
      });

      await expect(stat(`${directory}.stale-2026-10-03T12:00:02.000Z`)).resolves.toBeDefined();
    },
  );

  it('does not let a delayed heartbeat mutate a replacement owner', async () => {
    const first = await acquireOwnedLock({ directory, owner: owner('nest:first') });
    const replacement = {
      instance_id: 'nest:replacement',
      pid: 456,
      started_at: startedAt,
      heartbeat_at: startedAt,
      fencing_token: 'replacement-token',
    };
    await writeFile(path.join(directory, 'owner.json'), JSON.stringify(replacement));

    await first.heartbeat();

    expect(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'))).toEqual(
      replacement,
    );
  });

  it('does not overwrite a replacement acquired after heartbeat observes its token', async () => {
    const replacement = {
      instance_id: 'nest:replacement',
      pid: 456,
      started_at: startedAt,
      heartbeat_at: startedAt,
      fencing_token: 'replacement-token',
    };
    let nowCalls = 0;
    const first = await acquireOwnedLock({
      directory,
      owner: owner('nest:first'),
      now: () => {
        nowCalls += 1;
        if (nowCalls === 3) {
          renameSync(directory, `${directory}.stale-replaced`);
          mkdirSync(directory);
          writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(replacement));
        }
        return new Date(startedAt);
      },
    });

    await first.heartbeat();

    expect(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'))).toEqual(
      replacement,
    );
  });

  it('does not delete a replacement acquired after release observes its token', async () => {
    const replacement = {
      instance_id: 'nest:replacement',
      pid: 456,
      started_at: startedAt,
      heartbeat_at: startedAt,
      fencing_token: 'replacement-token',
    };
    let nowCalls = 0;
    const first = await acquireOwnedLock({
      directory,
      owner: owner('nest:first'),
      now: () => {
        nowCalls += 1;
        if (nowCalls === 3) {
          renameSync(directory, `${directory}.stale-replaced`);
          mkdirSync(directory);
          writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(replacement));
        }
        return new Date(startedAt);
      },
    });

    await first.release();

    expect(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'))).toEqual(
      replacement,
    );
  });

  it('does not let a delayed release delete a replacement owner', async () => {
    const first = await acquireOwnedLock({ directory, owner: owner('nest:first') });
    const replacement = {
      instance_id: 'nest:replacement',
      pid: 456,
      started_at: startedAt,
      heartbeat_at: startedAt,
      fencing_token: 'replacement-token',
    };
    await writeFile(path.join(directory, 'owner.json'), JSON.stringify(replacement));

    await first.release();

    expect(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'))).toEqual(
      replacement,
    );
  });

  it('keeps a held lock live beyond its lease with automatic heartbeat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startedAt));
    const first = await acquireOwnedLock({
      directory,
      owner: owner('nest:first'),
      leaseMs: 100,
      now: () => new Date(),
    });
    const stop = startOwnedLockHeartbeat(first, 50);

    await vi.advanceTimersByTimeAsync(250);
    await stop();

    expect(
      await inspectOwnedLock(directory, {
        leaseMs: 100,
        now: new Date(),
      }),
    ).toBe('live');
    await first.release();
    vi.useRealTimers();
  });

  it('allows only one contender to acquire a released generation', async () => {
    const initial = await acquireOwnedLock({
      directory,
      owner: owner('nest:initial'),
    });
    await initial.release();

    const contenders = await Promise.allSettled([
      acquireOwnedLock({
        directory,
        owner: owner('nest:first'),
        waitTimeoutMs: 0,
      }),
      acquireOwnedLock({
        directory,
        owner: owner('nest:second'),
        waitTimeoutMs: 0,
      }),
    ]);

    const winners = contenders.filter(
      (result): result is PromiseFulfilledResult<OwnedLockHandle> =>
        result.status === 'fulfilled',
    );
    expect(winners).toHaveLength(1);
    await winners[0]?.value.release();
  });

  it('releases every active handle during runner shutdown cleanup', async () => {
    await acquireOwnedLock({ directory, owner: owner('nest:first') });

    await releaseAllOwnedLocks();

    expect(await inspectOwnedLock(directory)).toBe('released');
  });
});
