import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireOwnedLock, type OwnedLockOwner } from '../state/owned-lock.js';
import { itemClaimDirectory, itemKey, withItemClaim } from './item-claims.js';

function owner(instanceId: string): OwnedLockOwner {
  const timestamp = new Date().toISOString();
  return { instanceId, pid: 42, startedAt: timestamp, heartbeatAt: timestamp };
}

describe('item claims', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'item-claims-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('uses consistent item keys', () => {
    expect(itemKey({ ticketId: '42' })).toBe('ticket:42');
    expect(itemKey({ incidentId: 'grafana-1' })).toBe('incident:grafana-1');
    expect(itemKey({ reorientationTicketId: '42' })).toBe('ticket:42');
    expect(itemKey({})).toBeUndefined();
  });

  it('adds a hash suffix so sanitized collisions stay distinct', () => {
    const first = itemClaimDirectory(stateDir, 'ticket:a/b');
    const second = itemClaimDirectory(stateDir, 'ticket:a?b');

    expect(path.basename(first)).toMatch(/^ticket_a_b-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
  });

  it('acquires and releases a claim around the callback', async () => {
    let called = false;
    const result = await withItemClaim(
      { stateDir, key: 'ticket:42', owner: owner('one'), batch: false },
      async () => {
        called = true;
        return 'done';
      },
    );

    expect(called).toBe(true);
    expect(result).toEqual({ status: 'processed', value: 'done' });
  });

  it('skips a live duplicate in a batch and throws for a single item', async () => {
    let releaseFirst!: () => void;
    const first = withItemClaim(
      { stateDir, key: 'ticket:42', owner: owner('one'), batch: false },
      () => new Promise<void>((resolve) => (releaseFirst = resolve)),
    );
    await expect
      .poll(async () => readdir(path.join(stateDir, 'item-locks')))
      .not.toEqual([]);

    await expect(
      withItemClaim(
        { stateDir, key: 'ticket:42', owner: owner('two'), batch: true },
        async () => undefined,
      ),
    ).resolves.toEqual({ status: 'skipped' });
    await expect(
      withItemClaim(
        { stateDir, key: 'ticket:42', owner: owner('two'), batch: false },
        async () => undefined,
      ),
    ).rejects.toThrow('Item is already being processed: ticket:42');

    releaseFirst();
    await first;
  });

  it('reclaims an expired owner even when the pid matches', async () => {
    let current = new Date('2026-01-01T00:00:00.000Z');
    const staleOwner = owner('old-container');
    staleOwner.heartbeatAt = current.toISOString();
    const staleClaim = await acquireOwnedLock({
      directory: itemClaimDirectory(stateDir, 'ticket:42'),
      owner: staleOwner,
      leaseMs: 100,
      now: () => current,
    });

    current = new Date(current.getTime() + 101);
    const result = await withItemClaim(
      {
        stateDir,
        key: 'ticket:42',
        owner: { ...owner('new-container'), pid: staleOwner.pid },
        batch: false,
        leaseMs: 100,
        now: () => current,
      },
      async () => 'recovered',
    );

    expect(result).toEqual({ status: 'processed', value: 'recovered' });
    await staleClaim.release();
  });
});
