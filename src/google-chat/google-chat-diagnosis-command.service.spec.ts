import { expect, it } from 'vitest';
import { googleChatConfig } from '../config/google-chat-config.js';
import { GoogleChatDiagnosisCommandService } from './google-chat-diagnosis-command.service.js';
import { GoogleChatThreadsService } from './google-chat-threads.service.js';

class MemoryState {
  files = {};

  async read(name) {
    return this.files[name] || {};
  }

  async update(name, mutate) {
    const value = this.files[name] || {};
    mutate(value);
    this.files[name] = value;
    return value;
  }
}

const ACTION_URL = 'https://ops.example.com/google-chat/events';

function chatConfig(env = {}) {
  return googleChatConfig({ GOOGLE_CHAT_ACTION_URL: ACTION_URL, ...env });
}

async function threadsWithTicketThread() {
  const state = new MemoryState();
  const threads = new GoogleChatThreadsService(state);
  await threads.bindTicketThread({
    space: 'spaces/AAA',
    threadName: 'spaces/AAA/threads/123',
    taskId: '42',
    ticketName: 'TICKET-42 — Falha no relatório',
    ticketUrl: 'https://app.clickup.com/t/42',
  });
  return { threads, state };
}

it('/processar acknowledgement and asynchronous run reuse the source thread', async () => {
  const bound = [];
  const enqueued = [];
  const command = new GoogleChatDiagnosisCommandService(
    {
      getTask: async () => ({
        id: '42',
        custom_id: 'TICKET-42',
        name: 'Falha no relatório',
        url: 'https://app.clickup.com/t/42',
      }),
    },
    {
      findActiveByTicket: async () => null,
      enqueue: async (options) => {
        enqueued.push(options);
        return { runId: 'run-1', completion: Promise.resolve() };
      },
    },
    {
      bindTicketThread: async (input) => {
        bound.push(input);
      },
    },
    {},
    chatConfig(),
  );
  const event = {
    type: 'MESSAGE',
    space: { name: 'spaces/AAA' },
    message: {
      text: '/processar https://app.clickup.com/t/42',
      slashCommand: { commandId: '1' },
      thread: { name: 'spaces/AAA/threads/source' },
    },
  };

  const result = await command.handle(event);

  expect(result.response).toStrictEqual({
    text: 'Processamento de **TICKET-42 — Falha no relatório** enfileirado. Run: `run-1`.',
    thread: { name: 'spaces/AAA/threads/source' },
  });
  expect(bound[0].threadName).toBe('spaces/AAA/threads/source');
  expect(enqueued[0].googleChatThread).toBe('spaces/AAA/threads/source');
});

it('/processar outside the existing ticket thread cannot replace its canonical binding', async () => {
  const { threads, state } = await threadsWithTicketThread();

  await threads.bindTicketThread({
    space: 'spaces/AAA',
    threadName: 'spaces/AAA/threads/new-process-command',
    taskId: '42',
    ticketName: 'TICKET-42 — Falha no relatório',
    ticketUrl: 'https://app.clickup.com/t/42',
  });

  expect(
    state.files['chat-ticket-threads.json']['spaces/AAA:driva-ticket-42']
      .threadName,
  ).toBe('spaces/AAA/threads/123');
});
