import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClickUpService } from '../clickup/clickup.service.js';
import { googleChatConfig } from '../config/google-chat-config.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { GoogleChatMessengerService } from '../google-chat/google-chat-messenger.service.js';
import type { ChatEvent } from '../google-chat/google-chat.types.js';
import { StateService } from '../state/state.service.js';
import { CommunicationCommandService } from './communication-command.service.js';
import type { CommunicationExecutionService } from './communication-execution.service.js';
import { CommunicationStore } from './communication-store.js';

function commandEvent(
  text: string,
  thread = 'spaces/dm/threads/t1',
): ChatEvent {
  return {
    type: 'MESSAGE',
    space: { name: 'spaces/dm' },
    user: { name: 'users/pm', displayName: 'Paula PM' },
    message: {
      text,
      argumentText: text.replace(/^\/comunicacao\s*/, ''),
      slashCommand: { commandId: '2' },
      thread: { name: thread },
    },
  };
}

describe('CommunicationCommandService', () => {
  let root: string;
  let store: CommunicationStore;
  const getTask = vi.fn();
  const start =
    vi.fn<
      (input: { communicationId: string; version: number }) => Promise<void>
    >();
  const sendMessage = vi.fn();

  function command() {
    return new CommunicationCommandService(
      { getTask } as unknown as ClickUpService,
      store,
      { start } as unknown as CommunicationExecutionService,
      googleChatConfig({}),
      { sendMessage } as unknown as GoogleChatMessengerService,
    );
  }

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    root = await mkdtemp(path.join(tmpdir(), 'communication-command-'));
    const runtime = {
      stateDir: path.join(root, 'state'),
      resultsDir: path.join(root, 'results'),
    } as RuntimeConfig;
    store = new CommunicationStore(
      new StateService(runtime, 'nest:test'),
      runtime,
    );
    getTask.mockReset();
    start.mockReset();
    start.mockResolvedValue(undefined);
    sendMessage.mockReset();
    sendMessage.mockResolvedValue({
      messageName: 'spaces/dm/messages/t1.ack',
      threadName: 'spaces/dm/threads/t1',
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('ignores other commands', async () => {
    expect(
      await command().handle({
        message: { text: '/processar x', slashCommand: { commandId: '1' } },
      }),
    ).toEqual({ handled: false });
  });

  it('replies with the same invalid link message as /processar', async () => {
    const result = await command().handle(commandEvent('/comunicacao oi'));
    expect(result).toEqual({
      handled: true,
      response: {
        text: 'Envie um link válido do ClickUp após o comando.',
        thread: { name: 'spaces/dm/threads/t1' },
      },
    });
    expect(getTask).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('creates the communication in the source thread and starts version 1', async () => {
    getTask.mockResolvedValue({
      id: '86abc',
      custom_id: 'TASK-7',
      name: 'Exportar conversas',
      url: 'https://app.clickup.com/t/86abc',
      team_id: '9013',
    });

    const result = await command().handle(
      commandEvent('/comunicacao https://app.clickup.com/t/86abc'),
    );

    expect(result).toEqual({ handled: true, response: {} });
    expect(sendMessage).toHaveBeenCalledWith(
      'spaces/dm',
      { text: 'Comunicação - Exportar conversas' },
      { threadName: 'spaces/dm/threads/t1' },
    );
    const record = await store.findByThread('spaces/dm/threads/t1');
    expect(record).toMatchObject({
      requester: { user: 'users/pm', displayName: 'Paula PM' },
      space: 'spaces/dm',
      task: {
        id: '86abc',
        customId: 'TASK-7',
        name: 'Exportar conversas',
        url: 'https://app.clickup.com/t/86abc',
        teamId: '9013',
      },
      status: 'generating',
    });
    expect(start).toHaveBeenCalledWith({
      communicationId: record?.id,
      version: 1,
    });
  });

  it('accepts the add-on app command payload', async () => {
    getTask.mockResolvedValue({
      id: '86abc',
      custom_id: 'TASK-7',
      name: 'Exportar conversas',
      url: 'https://app.clickup.com/t/86abc',
      team_id: '9013',
    });

    const result = await command().handle({
      chat: {
        user: { name: 'users/pm', displayName: 'Paula PM' },
        appCommandPayload: {
          space: { name: 'spaces/dm' },
          appCommandMetadata: {
            appCommandId: 2,
            appCommandType: 'SLASH_COMMAND',
          },
          message: {
            text: '/comunicacao https://app.clickup.com/t/86abc',
            argumentText: ' https://app.clickup.com/t/86abc',
            thread: { name: 'spaces/dm/threads/t1' },
          },
        },
      },
    });

    expect(result).toEqual({ handled: true, response: {} });
    expect(sendMessage).toHaveBeenCalledWith(
      'spaces/dm',
      { text: 'Comunicação - Exportar conversas' },
      { threadName: 'spaces/dm/threads/t1' },
    );
    expect(await store.findByThread('spaces/dm/threads/t1')).toMatchObject({
      space: 'spaces/dm',
      requester: { user: 'users/pm' },
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it('does not start a second communication in a thread that has one', async () => {
    getTask.mockResolvedValue({ id: '86abc', name: 'X' });
    await command().handle(
      commandEvent('/comunicacao https://app.clickup.com/t/86abc'),
    );
    start.mockClear();

    const result = await command().handle(
      commandEvent('/comunicacao https://app.clickup.com/t/86abc'),
    );

    expect(result.response).toMatchObject({
      text: 'Esta thread já tem uma comunicação. Envie /comunicacao fora dela para começar outra.',
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('binds feedback to the thread returned by Chat before starting generation', async () => {
    getTask.mockResolvedValue({ id: '86abc', name: 'Exportar conversas' });
    sendMessage.mockResolvedValue({
      messageName: 'spaces/dm/messages/created.ack',
      threadName: 'spaces/dm/threads/created',
    });
    start.mockImplementationOnce(async ({ communicationId }) => {
      expect(await store.find(communicationId)).toMatchObject({
        threadName: 'spaces/dm/threads/created',
      });
    });

    const result = await command().handle(
      commandEvent('/comunicacao https://app.clickup.com/t/86abc'),
    );

    expect(result).toEqual({ handled: true, response: {} });
    expect(await store.findByThread('spaces/dm/threads/t1')).toBeNull();
    expect(await store.findByThread('spaces/dm/threads/created')).toMatchObject(
      {
        task: { id: '86abc' },
        status: 'generating',
      },
    );
    expect(start).toHaveBeenCalledOnce();
  });

  it.each([
    ['post rejected', new Error('Google Chat API 403: forbidden')],
    ['thread omitted', null],
  ])(
    'does not start generation when the initial thread is unconfirmed: %s',
    async (_label, error) => {
      getTask.mockResolvedValue({ id: '86abc', name: 'Exportar conversas' });
      if (error) sendMessage.mockRejectedValueOnce(error);
      else
        sendMessage.mockResolvedValueOnce({
          messageName: 'spaces/dm/messages/ack',
        });

      const result = await command().handle(
        commandEvent('/comunicacao https://app.clickup.com/t/86abc'),
      );

      expect(result.handled).toBe(true);
      expect(result.response).toMatchObject({ text: expect.any(String) });
      expect(await store.findByThread('spaces/dm/threads/t1')).toBeNull();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it('maps ClickUp lookup failures to the user message', async () => {
    getTask.mockRejectedValue(new Error('ClickUp API 404: not found'));
    const result = await command().handle(
      commandEvent('/comunicacao https://app.clickup.com/t/86abc'),
    );
    expect(result.response).toMatchObject({
      text: 'Não encontrei esse ticket no ClickUp.',
    });
    expect(await store.findByThread('spaces/dm/threads/t1')).toBeNull();
  });
});
