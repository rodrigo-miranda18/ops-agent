import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleChatConfig } from '../config/google-chat-config.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { GoogleChatMessengerService } from '../google-chat/google-chat-messenger.service.js';
import type { ChatEvent } from '../google-chat/google-chat.types.js';
import { StateService } from '../state/state.service.js';
import { CommunicationActionsService } from './communication-actions.service.js';
import {
  CommunicationStore,
  type CommunicationRecord,
} from './communication-store.js';
import type { MediaStorage } from './media-storage.js';

const READY_FIXTURE = fileURLToPath(
  new URL('./fixtures/ready.json', import.meta.url),
);
const INSUFFICIENT_FIXTURE = fileURLToPath(
  new URL('./fixtures/insufficient.json', import.meta.url),
);
const NEWS = 'spaces/news';

function approve(
  communicationId: string,
  version: number,
  user = 'users/pm',
): ChatEvent {
  return {
    commonEventObject: {
      invokedFunction: 'communication_approve',
      parameters: { communicationId, version: String(version) },
    },
    space: { name: 'spaces/dm' },
    user: { name: user },
  };
}

describe('CommunicationActionsService', () => {
  let root: string;
  let store: CommunicationStore;
  const sendMessage = vi.fn();
  const resolveMemberName = vi.fn();
  const publish = vi.fn<(name: string) => Promise<string>>();
  let storage: MediaStorage | null;

  function service(
    env: Record<string, string> = { GOOGLE_CHAT_NEWS_SPACE: NEWS },
  ) {
    return new CommunicationActionsService(
      store,
      {
        sendMessage,
        resolveMemberName,
      } as unknown as GoogleChatMessengerService,
      googleChatConfig(env),
      storage,
    );
  }

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'communication-actions-'));
    const runtime = {
      stateDir: path.join(root, 'state'),
      resultsDir: path.join(root, 'results'),
    } as RuntimeConfig;
    store = new CommunicationStore(
      new StateService(runtime, 'nest:test'),
      runtime,
    );
    resolveMemberName.mockReset();
    resolveMemberName.mockResolvedValue('users/123456');
    sendMessage.mockReset();
    publish.mockReset();
    publish.mockImplementation((name) =>
      Promise.resolve(`https://cdn.example/published/${name}`),
    );
    storage = { uploadDraft: vi.fn(), publish };
    sendMessage.mockResolvedValue({
      messageName: 'spaces/news/messages/m1',
      threadName: 'spaces/news/threads/t9',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function readyCommunication(
    fixture = READY_FIXTURE,
    media: unknown[] = [],
  ): Promise<CommunicationRecord> {
    const record = await store.create({
      requester: { user: 'users/pm', displayName: 'PM' },
      space: 'spaces/dm',
      threadName: 'spaces/dm/threads/t1',
      task: { id: 'abc', customId: null, name: 'Export', url: 'u' },
    });
    const dir = record.versions[0]!.artifactDir;
    await mkdir(path.join(dir, 'context'), { recursive: true });
    await copyFile(fixture, path.join(dir, 'output.json'));
    await writeFile(path.join(dir, 'media.json'), JSON.stringify(media));
    await writeFile(
      path.join(dir, 'context', 'clickup.json'),
      JSON.stringify({
        improvementTickets: [
          {
            id: '1',
            customId: 'TICKET-1',
            name: 'Exportar',
            url: 'https://app.clickup.com/t/1',
            owners: [{ username: 'Ana CS', email: 'anpessoa1@example.com' }],
          },
        ],
      }),
    );
    await store.finishVersion(record.id, 1, 'ready', 'spaces/dm/messages/c1');
    return record;
  }

  it('publishes the approved version with a real mention and links it in the thread', async () => {
    const record = await readyCommunication();

    const reply = await service().handleAction(approve(record.id, 1));

    expect(reply).toEqual({
      text: 'Versão 1 publicada no espaço de novidades: https://chat.google.com/room/news/t9',
    });
    expect(resolveMemberName).toHaveBeenCalledWith(
      NEWS,
      'anpessoa1@example.com',
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [space, { text }] = sendMessage.mock.calls[0] as [
      string,
      { text: string },
    ];
    expect(space).toBe(NEWS);
    expect(text).toContain('📁 Exportar conversas para Excel (.xlsx)');
    expect(text).toContain(
      'Ticket de melhoria aberto por <users/123456>: https://app.clickup.com/t/1',
    );
    expect((await store.find(record.id))?.published).toMatchObject({
      version: 1,
      messageName: 'spaces/news/messages/m1',
      publishedBy: 'users/pm',
    });
  });

  it.each([null, new Error('Google Chat API 403')])(
    'publica pelo nome e avisa se não consegue resolver a menção (%s)',
    async (result) => {
      const record = await readyCommunication();
      if (result instanceof Error) resolveMemberName.mockRejectedValue(result);
      else resolveMemberName.mockResolvedValue(result);
      const reply = await service().handleAction(approve(record.id, 1));
      const { text } = sendMessage.mock.calls[0]?.[1] as { text: string };
      expect(text).toContain('Ticket de melhoria aberto por Ana CS');
      expect(text).not.toContain('<users/');
      expect(reply.text).toContain('Sem marcação no Chat: Ana CS');
      expect((await store.find(record.id))?.published?.version).toBe(1);
    },
  );

  it('publishes exactly once for two simultaneous approvals', async () => {
    const record = await readyCommunication();

    const replies = await Promise.all([
      service().handleAction(approve(record.id, 1)),
      service().handleAction(approve(record.id, 1)),
    ]);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(replies).toContainEqual({
      text: 'Esta comunicação já foi publicada.',
    });
  });

  it('refuses to publish another version after publication', async () => {
    const record = await readyCommunication();
    await service().handleAction(approve(record.id, 1));
    const next = await store.startVersion(record.id, 'outra');
    expect(next).toEqual({ version: 2 });
    await store.finishVersion(record.id, 2, 'ready');

    expect(await service().handleAction(approve(record.id, 2))).toEqual({
      text: 'Esta comunicação já foi publicada.',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects approval from someone other than the requester', async () => {
    const record = await readyCommunication();
    expect(
      await service().handleAction(approve(record.id, 1, 'users/other')),
    ).toEqual({ text: 'Só quem pediu a comunicação pode aprová-la.' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(resolveMemberName).not.toHaveBeenCalled();
  });

  it('rejects approval of a version that is not ready', async () => {
    const record = await readyCommunication();
    await store.startVersion(record.id, 'mais curto');
    expect(await service().handleAction(approve(record.id, 2))).toEqual({
      text: 'Esta versão não está pronta para publicação.',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('releases the claim and reports the error when publishing fails', async () => {
    const record = await readyCommunication();
    sendMessage.mockRejectedValueOnce(new Error('Google Chat API 403: denied'));

    expect(await service().handleAction(approve(record.id, 1))).toEqual({
      text: 'Não consegui publicar a comunicação: Google Chat API 403: denied',
    });
    expect(await store.find(record.id)).toMatchObject({
      status: 'ready',
      published: null,
      publishing: null,
    });
    expect(await service().handleAction(approve(record.id, 1))).toMatchObject({
      text: expect.stringContaining(
        'publicada no espaço de novidades',
      ) as string,
    });
  });

  it('does not claim when the news space is not configured', async () => {
    const record = await readyCommunication();
    expect(await service({}).handleAction(approve(record.id, 1))).toEqual({
      text: 'O espaço de novidades (GOOGLE_CHAT_NEWS_SPACE) não está configurado.',
    });
    expect((await store.find(record.id))?.status).toBe('ready');
  });

  it('rejects approval of an insufficient-context version before claiming', async () => {
    const record = await readyCommunication(INSUFFICIENT_FIXTURE);
    const claim = vi.spyOn(store, 'claimPublication');

    expect(await service().handleAction(approve(record.id, 1))).toEqual({
      text: 'Esta versão não está pronta para publicação.',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await store.find(record.id)).toMatchObject({
      status: 'ready',
      published: null,
      publishing: null,
    });
  });

  const DRAFT_IMAGE = {
    name: 'a.png',
    url: 'https://signed.example/a.png?sig=1',
    caption: 'Tela de exportação',
  };

  it('publishes text only when the version has no images', async () => {
    const record = await readyCommunication();
    await service().handleAction(approve(record.id, 1));
    expect(sendMessage.mock.calls[0]?.[1]).not.toHaveProperty('cardsV2');
    expect(publish).not.toHaveBeenCalled();
  });

  it('copies images before sending and uses their public URLs', async () => {
    const record = await readyCommunication(READY_FIXTURE, [DRAFT_IMAGE]);
    await service().handleAction(approve(record.id, 1));

    expect(publish).toHaveBeenCalledWith('a.png');
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessage.mock.invocationCallOrder[0] as number,
    );
    const body = JSON.stringify(sendMessage.mock.calls[0]?.[1]);
    expect(body).toContain('https://cdn.example/published/a.png');
    expect(body).toContain('Tela de exportação');
    expect(body).not.toContain('signed.example');
  });

  it('publishes the text and reports it when an image copy fails', async () => {
    const record = await readyCommunication(READY_FIXTURE, [DRAFT_IMAGE]);
    publish.mockRejectedValueOnce(new Error('copy denied'));

    const reply = await service().handleAction(approve(record.id, 1));

    expect(reply.text).toContain('Imagens que não entraram na publicação: 1.');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[1]).not.toHaveProperty('cardsV2');
    expect(await store.find(record.id)).toMatchObject({ status: 'published' });
  });

  it('publishes the text when storage is not configured', async () => {
    const record = await readyCommunication(READY_FIXTURE, [DRAFT_IMAGE]);
    storage = null;

    const reply = await service().handleAction(approve(record.id, 1));

    expect(reply.text).toContain('Imagens que não entraram na publicação: 1.');
    expect(sendMessage.mock.calls[0]?.[1]).not.toHaveProperty('cardsV2');
  });
});
