import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../config/runtime-config.js';
import { StateService } from '../state/state.service.js';
import { CommunicationStore } from './communication-store.js';

describe('CommunicationStore', () => {
  let root: string;
  let store: CommunicationStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'communication-store-'));
    const runtime = {
      stateDir: path.join(root, 'state'),
      resultsDir: path.join(root, 'results'),
    } as RuntimeConfig;
    store = new CommunicationStore(
      new StateService(runtime, 'nest:test'),
      runtime,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function readyCommunication() {
    const record = await store.create({
      requester: { user: 'users/pm', displayName: 'PM' },
      space: 'spaces/dm',
      threadName: 'spaces/dm/threads/t1',
      task: { id: 'abc', customId: 'TICKET-1', name: 'Export', url: 'u' },
    });
    await store.finishVersion(record.id, 1, 'ready', 'spaces/dm/messages/m1');
    return record;
  }

  it('creates version 1 in generating with its artifact directory', async () => {
    const record = await store.create({
      requester: { user: 'users/pm', displayName: 'PM' },
      space: 'spaces/dm',
      threadName: 'spaces/dm/threads/t1',
      task: { id: 'abc', customId: null, name: 'Export', url: 'u' },
    });
    expect(record.status).toBe('generating');
    expect(record.versions).toEqual([
      expect.objectContaining({
        number: 1,
        status: 'generating',
        feedback: null,
        artifactDir: path.join(
          root,
          'results',
          'communications',
          record.id,
          'v1',
        ),
      }),
    ]);
    await expect(store.find(record.id)).resolves.toEqual(record);
    await expect(store.findByThread('spaces/dm/threads/t1')).resolves.toEqual(
      record,
    );
    await expect(store.findByThread('other')).resolves.toBeNull();
  });

  it('grants exactly one of two parallel claims', async () => {
    const { id } = await readyCommunication();
    const claims = await Promise.all([
      store.claimPublication(id, 1, 'users/pm'),
      store.claimPublication(id, 1, 'users/pm'),
    ]);
    expect(claims.filter((claim) => claim === 'claimed')).toHaveLength(1);
  });

  it('returns already_published for any version after publication', async () => {
    const { id } = await readyCommunication();
    await store.startVersion(id, 'mais curto');
    await store.finishVersion(id, 2, 'ready');
    expect(await store.claimPublication(id, 1, 'users/pm')).toBe('claimed');
    await store.completePublication(id, 'spaces/news/messages/n1');
    expect(await store.claimPublication(id, 1, 'users/pm')).toBe(
      'already_published',
    );
    expect(await store.claimPublication(id, 2, 'users/pm')).toBe(
      'already_published',
    );
    const record = await store.find(id);
    expect(record?.status).toBe('published');
    expect(record?.published).toEqual(
      expect.objectContaining({
        version: 1,
        messageName: 'spaces/news/messages/n1',
        publishedBy: 'users/pm',
      }),
    );
  });

  it('rejects a claim from someone other than the requester', async () => {
    const { id } = await readyCommunication();
    expect(await store.claimPublication(id, 1, 'users/other')).toBe(
      'not_requester',
    );
  });

  it('lets anyone claim an API-origin communication', async () => {
    const record = await store.create({
      requester: { user: 'api', displayName: 'Rotina de comunicação' },
      apiOrigin: true,
      space: 'spaces/pd',
      threadName: 'spaces/pd/threads/t1',
      task: { id: 'abc', customId: 'TICKET-1', name: 'Export', url: 'u' },
    });
    expect(record.apiOrigin).toBe(true);
    await store.finishVersion(record.id, 1, 'ready', 'spaces/pd/messages/m1');
    expect(await store.claimPublication(record.id, 1, 'users/anyone')).toBe(
      'claimed',
    );
  });

  it('rejects a claim for a version that is not ready', async () => {
    const { id } = await readyCommunication();
    await store.startVersion(id, 'ajuste');
    expect(await store.claimPublication(id, 2, 'users/pm')).toBe('not_ready');
  });

  it('reports busy while a version is generating', async () => {
    const { id } = await readyCommunication();
    expect(await store.startVersion(id, 'ajuste')).toEqual({ version: 2 });
    expect(await store.startVersion(id, 'outro ajuste')).toEqual({
      busy: true,
    });
    const record = await store.find(id);
    expect(record?.versions[1]).toEqual(
      expect.objectContaining({ feedback: 'ajuste', status: 'generating' }),
    );
  });

  it('returns to ready when a publication is released', async () => {
    const { id } = await readyCommunication();
    await store.claimPublication(id, 1, 'users/pm');
    await store.releasePublication(id);
    const record = await store.find(id);
    expect(record?.status).toBe('ready');
    expect(record?.published).toBeNull();
    expect(await store.claimPublication(id, 1, 'users/pm')).toBe('claimed');
  });

  it('fails stale generations and reports them', async () => {
    const generating = await store.create({
      requester: { user: 'users/pm', displayName: 'PM' },
      space: 'spaces/dm',
      threadName: 'spaces/dm/threads/t2',
      task: { id: 'def', customId: null, name: 'Other', url: 'u' },
    });
    await readyCommunication();
    expect(await store.failStaleGenerations()).toEqual([
      {
        id: generating.id,
        version: 1,
        space: 'spaces/dm',
        threadName: 'spaces/dm/threads/t2',
      },
    ]);
    const record = await store.find(generating.id);
    expect(record?.status).toBe('failed');
    expect(record?.versions[0]?.status).toBe('failed');
    expect(await store.failStaleGenerations()).toEqual([]);
  });
});
