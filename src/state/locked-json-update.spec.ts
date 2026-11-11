import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireOwnedLock, type OwnedLockOwner } from './owned-lock.js';
import { updateJsonFileLocked } from './locked-json-update.js';

const startedAt = '2026-10-03T12:00:00.000Z';

function owner(instanceId: string): OwnedLockOwner {
  return { instanceId, pid: 123, startedAt, heartbeatAt: startedAt };
}

describe('updateJsonFileLocked', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'locked-json-update-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('starts missing files as an empty object', async () => {
    const filename = path.join(directory, 'state.json');

    const state = await updateJsonFileLocked(
      filename,
      owner('runner:a'),
      (current) => {
        current.first = true;
      },
    );

    expect(state).toEqual({ first: true });
    await expect(readFile(filename, 'utf8')).resolves.toBe(
      '{\n  "first": true\n}\n',
    );
  });

  it('preserves concurrent updates from separate owners', async () => {
    const filename = path.join(directory, 'state.json');

    await Promise.all([
      updateJsonFileLocked(filename, owner('runner:a'), async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        current.first = true;
      }),
      updateJsonFileLocked(filename, owner('runner:b'), (current) => {
        current.second = true;
      }),
    ]);

    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({
      first: true,
      second: true,
    });
  });

  it('does not retain stale audit directories after repeated successful updates', async () => {
    const filename = path.join(directory, 'state.json');

    for (let count = 0; count < 3; count += 1) {
      await updateJsonFileLocked(filename, owner(`runner:${count}`), (current) => {
        current[`update_${count}`] = true;
      });
    }

    expect(
      (await readdir(directory)).filter((entry) => entry.startsWith('state.json.lock.')),
    ).toEqual([]);
  });

  it('does not write when the mutator fails', async () => {
    const filename = path.join(directory, 'state.json');
    await updateJsonFileLocked(filename, owner('runner:a'), (current) => {
      current.persisted = true;
    });
    const before = await readFile(filename, 'utf8');

    await expect(
      updateJsonFileLocked(filename, owner('runner:b'), () => {
        throw new Error('mutation failed');
      }),
    ).rejects.toThrow('mutation failed');

    await expect(readFile(filename, 'utf8')).resolves.toBe(before);
  });

  it('surfaces an error when a live lock times out', async () => {
    const filename = path.join(directory, 'state.json');
    const liveOwner = new Date().toISOString();
    const lock = await acquireOwnedLock({
      directory: `${filename}.lock`,
      owner: {
        instanceId: 'runner:a',
        pid: 123,
        startedAt: liveOwner,
        heartbeatAt: liveOwner,
      },
    });

    try {
      await expect(
        updateJsonFileLocked(
          filename,
          owner('runner:b'),
          () => undefined,
          { waitTimeoutMs: 0 },
        ),
      ).rejects.toThrow('Timed out acquiring owned lock');
    } finally {
      await lock.release();
    }
  });

  it('uses separate locks for separate files', async () => {
    const first = path.join(directory, 'first.json');
    const second = path.join(directory, 'second.json');
    const lock = await acquireOwnedLock({
      directory: `${first}.lock`,
      owner: owner('runner:a'),
    });

    try {
      await expect(
        updateJsonFileLocked(second, owner('runner:b'), (current) => {
          current.updated = true;
        }),
      ).resolves.toEqual({ updated: true });
    } finally {
      await lock.release();
    }
  });
});
