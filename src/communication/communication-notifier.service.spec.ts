import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleChatConfig } from '../config/google-chat-config.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { GoogleChatMessengerService } from '../google-chat/google-chat-messenger.service.js';
import { StateService } from '../state/state.service.js';
import { CommunicationNotifier } from './communication-notifier.service.js';
import {
  CommunicationStore,
  type CommunicationRecord,
} from './communication-store.js';

function fixture(name: string) {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const THREAD = 'spaces/dm/threads/t1';

describe('CommunicationNotifier', () => {
  let root: string;
  let store: CommunicationStore;
  let notifier: CommunicationNotifier;
  const sendMessage = vi.fn();
  const sendText = vi.fn();

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'communication-notifier-'));
    const runtime = {
      stateDir: path.join(root, 'state'),
      resultsDir: path.join(root, 'results'),
    } as RuntimeConfig;
    store = new CommunicationStore(
      new StateService(runtime, 'nest:test'),
      runtime,
    );
    sendMessage.mockReset();
    sendMessage.mockResolvedValue({
      messageName: 'spaces/dm/messages/card1',
      threadName: THREAD,
    });
    sendText.mockReset();
    sendText.mockResolvedValue({ messageName: 'spaces/dm/messages/t' });
    notifier = new CommunicationNotifier(
      store,
      { sendMessage, sendText } as unknown as GoogleChatMessengerService,
      googleChatConfig({
        GOOGLE_CHAT_ACTION_URL: 'https://ops.example.com/google-chat/events',
      }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function generating(output?: string): Promise<CommunicationRecord> {
    const record = await store.create({
      requester: { user: 'users/pm', displayName: 'PM' },
      space: 'spaces/dm',
      threadName: THREAD,
      task: { id: 'abc', customId: 'TASK-1', name: 'Export', url: 'u' },
    });
    const dir = record.versions[0]!.artifactDir;
    await mkdir(path.join(dir, 'context'), { recursive: true });
    if (output) await copyFile(fixture(output), path.join(dir, 'output.json'));
    await writeFile(
      path.join(dir, 'context', 'warnings.json'),
      JSON.stringify(['PR #9 inacessível']),
    );
    return record;
  }

  it('posts the version card in the thread and marks the version ready', async () => {
    const record = await generating('ready.json');

    await notifier.versionReady({ communicationId: record.id, version: 1 });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [space, card, thread] = sendMessage.mock.calls[0] as [
      string,
      unknown,
      unknown,
    ];
    expect(space).toBe('spaces/dm');
    expect(thread).toEqual({ threadName: THREAD, requireExistingThread: true });
    const json = JSON.stringify(card);
    expect(json).toContain('Versão 1');
    expect(json).toContain('Aprovar e publicar');
    expect(json).toContain('PR #9 inacessível');
    const updated = await store.find(record.id);
    expect(updated?.status).toBe('ready');
    expect(updated?.versions[0]).toMatchObject({
      status: 'ready',
      cardMessageName: 'spaces/dm/messages/card1',
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined, 'output.json não foi gerado'],
    ['invalid', 'invalid.json', 'Invalid communication links[0].kind'],
  ])(
    'fails the version and warns the thread when the output is %s',
    async (_label, output, reason) => {
      const record = await generating(output);

      await notifier.versionReady({ communicationId: record.id, version: 1 });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(sendText).toHaveBeenCalledWith(
        'spaces/dm',
        expect.stringContaining('A geração da versão 1 falhou: saída inválida'),
        { threadName: THREAD, requireExistingThread: true },
      );
      expect(sendText.mock.calls[0]?.[1]).toContain(reason);
      const updated = await store.find(record.id);
      expect(updated?.status).toBe('failed');
      expect(updated?.versions[0]?.status).toBe('failed');
    },
  );

  it('fails the version when the card cannot be posted', async () => {
    const record = await generating('ready.json');
    sendMessage.mockRejectedValueOnce(new Error('Google Chat API 500'));

    await notifier.versionReady({ communicationId: record.id, version: 1 });

    expect((await store.find(record.id))?.versions[0]?.status).toBe('failed');
    expect(sendText).toHaveBeenCalledWith(
      'spaces/dm',
      expect.stringContaining('não consegui postar o card'),
      { threadName: THREAD, requireExistingThread: true },
    );
  });

  it.each(['spaces/dm/threads/other', undefined])(
    'fails instead of marking ready when Chat returns an unconfirmed thread: %s',
    async (threadName) => {
      const record = await generating('ready.json');
      sendMessage.mockResolvedValueOnce({
        messageName: 'spaces/dm/messages/other.card',
        threadName,
      });

      await notifier.versionReady({ communicationId: record.id, version: 1 });

      const updated = await store.find(record.id);
      expect(updated?.versions[0]?.status).toBe('failed');
      expect(updated?.versions[0]?.cardMessageName).toBeNull();
      expect(sendText).toHaveBeenCalledWith(
        'spaces/dm',
        expect.stringContaining('não consegui postar o card'),
        { threadName: THREAD, requireExistingThread: true },
      );
    },
  );

  it('marks the version failed and tells the thread why', async () => {
    const record = await generating();

    await notifier.versionFailed({
      communicationId: record.id,
      version: 1,
      error: 'A geração foi interrompida por um reinício do serviço.',
    });

    expect((await store.find(record.id))?.versions[0]?.status).toBe('failed');
    expect(sendText).toHaveBeenCalledWith(
      'spaces/dm',
      'A geração da versão 1 falhou: A geração foi interrompida por um reinício do serviço.\nEnvie uma mensagem nesta thread para tentar de novo.',
      { threadName: THREAD, requireExistingThread: true },
    );
  });

  it('reports a missing action URL as a configuration failure, not invalid output', async () => {
    notifier = new CommunicationNotifier(
      store,
      { sendMessage, sendText } as unknown as GoogleChatMessengerService,
      googleChatConfig({}),
    );
    const record = await generating('ready.json');

    await notifier.versionReady({ communicationId: record.id, version: 1 });

    expect(sendMessage).not.toHaveBeenCalled();
    const text = String(sendText.mock.calls[0]?.[1]);
    expect(text).toContain('erro de configuração do agente');
    expect(text).toContain('GOOGLE_CHAT_ACTION_URL');
    expect(text).not.toContain('saída inválida');
    expect((await store.find(record.id))?.versions[0]?.status).toBe('failed');
  });

  it('marks the version failed when recording the posted card throws', async () => {
    const record = await generating('ready.json');
    const finish = store.finishVersion.bind(store);
    vi.spyOn(store, 'finishVersion').mockImplementation(
      (id, version, status, card) =>
        status === 'ready'
          ? Promise.reject(new Error('disk full'))
          : finish(id, version, status, card),
    );

    await expect(
      notifier.versionReady({ communicationId: record.id, version: 1 }),
    ).rejects.toThrow('disk full');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const updated = await store.find(record.id);
    expect(updated?.versions[0]?.status).toBe('failed');
    expect(updated?.status).toBe('failed');
  });

  it('marks the version failed when the record lookup throws', async () => {
    const record = await generating('ready.json');
    vi.spyOn(store, 'find').mockRejectedValueOnce(new Error('bad state'));

    await expect(
      notifier.versionReady({ communicationId: record.id, version: 1 }),
    ).rejects.toThrow('bad state');

    expect((await store.find(record.id))?.versions[0]?.status).toBe('failed');
  });
});
