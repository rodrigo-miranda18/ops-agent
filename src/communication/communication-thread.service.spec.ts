import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { ChatEvent } from '../google-chat/google-chat.types.js';
import { StateService } from '../state/state.service.js';
import type { CommunicationExecutionService } from './communication-execution.service.js';
import { CommunicationStore } from './communication-store.js';
import { CommunicationThreadService } from './communication-thread.service.js';

const THREAD = 'spaces/dm/threads/t1';

function message(user: string, text: string, thread = THREAD): ChatEvent {
  return {
    type: 'MESSAGE',
    space: { name: 'spaces/dm' },
    user: { name: user },
    message: { text, thread: { name: thread } },
  };
}

describe('CommunicationThreadService', () => {
  let root: string;
  let store: CommunicationStore;
  let service: CommunicationThreadService;
  const start = vi.fn(() => Promise.resolve());

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'communication-thread-'));
    const runtime = {
      stateDir: path.join(root, 'state'),
      resultsDir: path.join(root, 'results'),
    } as RuntimeConfig;
    store = new CommunicationStore(
      new StateService(runtime, 'nest:test'),
      runtime,
    );
    service = new CommunicationThreadService(store, {
      start,
    } as unknown as CommunicationExecutionService);
    start.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function communication() {
    return store.create({
      requester: { user: 'users/pm', displayName: 'PM' },
      space: 'spaces/dm',
      threadName: THREAD,
      task: { id: 'abc', customId: null, name: 'Export', url: 'u' },
    });
  }

  it('ignores threads without a communication', async () => {
    await communication();
    expect(
      await service.handleMessage(
        message('users/pm', 'oi', 'spaces/dm/threads/x'),
      ),
    ).toBeNull();
  });

  it('rejects feedback from someone other than the requester', async () => {
    const record = await communication();
    await store.finishVersion(record.id, 1, 'ready');

    expect(await service.handleMessage(message('users/other', 'mude'))).toEqual(
      { text: 'Só quem pediu a comunicação pode ajustá-la.' },
    );
    expect((await store.find(record.id))?.versions).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects feedback while a version is generating', async () => {
    const record = await communication();

    expect(await service.handleMessage(message('users/pm', 'mude'))).toEqual({
      text: 'Ainda estou gerando a versão 1; envie o ajuste quando ela chegar.',
    });
    expect((await store.find(record.id))?.versions).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('turns requester feedback into a new version', async () => {
    const record = await communication();
    await store.finishVersion(record.id, 1, 'failed');

    expect(
      await service.handleMessage(message('users/pm', '  mais curto  ')),
    ).toEqual({ text: 'Gerando a versão 2 com o seu ajuste…' });
    const updated = await store.find(record.id);
    expect(updated?.versions[1]).toMatchObject({
      number: 2,
      feedback: 'mais curto',
      status: 'generating',
    });
    expect(start).toHaveBeenCalledWith({
      communicationId: record.id,
      version: 2,
    });
  });

  it('accepts only one of two simultaneous feedback messages', async () => {
    const record = await communication();
    await store.finishVersion(record.id, 1, 'ready');

    const replies = await Promise.all([
      service.handleMessage(message('users/pm', 'a')),
      service.handleMessage(message('users/pm', 'b')),
    ]);

    expect(replies).toEqual(
      expect.arrayContaining([
        { text: 'Gerando a versão 2 com o seu ajuste…' },
        {
          text: 'Ainda estou gerando a versão 2; envie o ajuste quando ela chegar.',
        },
      ]),
    );
    expect((await store.find(record.id))?.versions).toHaveLength(2);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not start a version once the communication is published', async () => {
    const record = await communication();
    await store.finishVersion(record.id, 1, 'ready');
    await store.claimPublication(record.id, 1, 'users/pm');
    await store.completePublication(record.id, 'spaces/news/messages/m1');

    expect(await service.handleMessage(message('users/pm', 'mude'))).toEqual({
      text: 'Esta comunicação já foi publicada. Use /comunicacao para gerar uma nova.',
    });
    expect((await store.find(record.id))?.versions).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
  });
});
