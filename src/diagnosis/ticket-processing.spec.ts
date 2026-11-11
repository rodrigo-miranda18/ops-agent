import { mkdir, readFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedLockOwner } from '../state/owned-lock.js';

const testState = vi.hoisted(() => {
  const directory = `/tmp/ticket-processing-${process.pid}-${Date.now()}`;
  return { directory, file: `${directory}/processed.json` };
});

vi.mock('../runner/runner-paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runner/runner-paths.js')>()),
  stateFile: testState.file,
}));

const { isProcessedTicketVersion, markProcessed } =
  await import('./ticket-processing.js');

function owner(instanceId: string): OwnedLockOwner {
  const now = new Date().toISOString();
  return { instanceId, pid: process.pid, startedAt: now, heartbeatAt: now };
}

describe('processed ticket state', () => {
  beforeEach(async () => {
    await rm(testState.directory, { recursive: true, force: true });
    await mkdir(testState.directory, { recursive: true });
  });

  afterEach(async () => {
    await rm(testState.directory, { recursive: true, force: true });
  });

  it('recognizes only the exact processed ticket version', () => {
    const processed = { '42:2026-10-03T12:00:00.000Z': {} };

    expect(
      isProcessedTicketVersion(processed, {
        id: '42',
        date_updated: String(Date.parse('2026-10-03T12:00:00.000Z')),
      }),
    ).toBe(true);
    expect(
      isProcessedTicketVersion(processed, {
        id: '42',
        date_updated: String(Date.parse('2026-10-03T12:01:00.000Z')),
      }),
    ).toBe(false);
  });

  it('merges ticket versions using the processed-state shape', async () => {
    await markProcessed(
      { id: 'ticket-1', updated_at: '2026-10-03T12:00:00.000Z' },
      '2026-10-03T12:01:00.000Z',
      owner('runner:first'),
    );
    await markProcessed(
      { id: 'ticket-2', updated_at: '2026-10-03T12:02:00.000Z' },
      '2026-10-03T12:03:00.000Z',
      owner('runner:second'),
    );

    expect(JSON.parse(await readFile(testState.file, 'utf8'))).toEqual({
      'ticket-1:2026-10-03T12:00:00.000Z': {
        ticket_id: 'ticket-1',
        updated_at: '2026-10-03T12:00:00.000Z',
        processed_at: '2026-10-03T12:01:00.000Z',
      },
      'ticket-2:2026-10-03T12:02:00.000Z': {
        ticket_id: 'ticket-2',
        updated_at: '2026-10-03T12:02:00.000Z',
        processed_at: '2026-10-03T12:03:00.000Z',
      },
    });
  });
});
