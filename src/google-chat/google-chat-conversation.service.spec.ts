import { expect, it } from 'vitest';
import { googleChatConfig } from '../config/google-chat-config.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';
import { GoogleChatThreadsService } from './google-chat-threads.service.js';
import { GoogleChatConversationService } from './google-chat-conversation.service.js';

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

function ticketThreadEvent(
  userName,
  text,
  threadName = 'spaces/AAA/threads/123',
) {
  return {
    type: 'MESSAGE',
    space: { name: 'spaces/AAA' },
    user: { name: userName },
    message: { text, thread: { name: threadName } },
  };
}

async function serviceWithTicketThread(env = {}) {
  const state = new MemoryState();
  const config = googleChatConfig({
    GOOGLE_CHAT_ACTION_URL: 'https://ops.example.com/google-chat/events',
    ...env,
  });
  const service = new GoogleChatConversationService(
    state,
    new GoogleChatMessengerService(config),
    config,
    runtimeConfig({}, process.cwd()),
  );
  await new GoogleChatThreadsService(state).bindTicketThread({
    space: 'spaces/AAA',
    threadName: 'spaces/AAA/threads/123',
    taskId: '42',
    ticketName: 'TICKET-42 — Falha no relatório',
    ticketUrl: 'https://app.clickup.com/t/42',
  });
  return { service, state };
}

it('rejects an event without a thread before queueing Codex', async () => {
  const { service } = await serviceWithTicketThread();
  let queued = false;
  service.enqueueConversation = () => {
    queued = true;
  };
  const event = ticketThreadEvent('users/1', 'Sem thread');
  delete event.message.thread;

  const response = await service.handleMessage(event);

  expect(queued).toBe(false);
  expect(response).toStrictEqual({
    text: 'Não foi possível identificar o usuário ou a thread do ticket.',
  });
});

it('serializes questions by ticket thread', async () => {
  const { service } = await serviceWithTicketThread();
  const order = [];
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  service.answerConversation = async (_bindingKey, text) => {
    order.push(`start:${text}`);
    if (text === 'primeira') await firstBlocked;
    order.push(`end:${text}`);
  };

  service.enqueueConversation('spaces/AAA:driva-ticket-42', 'primeira');
  service.enqueueConversation('spaces/AAA:driva-ticket-42', 'segunda');
  await new Promise((resolve) => setImmediate(resolve));
  expect(order).toStrictEqual(['start:primeira']);
  releaseFirst();
  await service.conversationQueues.get('spaces/AAA:driva-ticket-42');
  expect(order).toStrictEqual([
    'start:primeira',
    'end:primeira',
    'start:segunda',
    'end:segunda',
  ]);
});

it('bounds shared thread history by the configured turn limit', async () => {
  const { service, state } = await serviceWithTicketThread({
    GOOGLE_CHAT_CONVERSATION_HISTORY_TURNS: '1',
  });
  service.enqueueConversation = () => undefined;
  await service.handleMessage(ticketThreadEvent('users/1', 'primeira'));
  await service.handleMessage(ticketThreadEvent('users/2', 'segunda'));
  await service.handleMessage(ticketThreadEvent('users/1', 'terceira'));

  expect(
    state.files['chat-ticket-threads.json'][
      'spaces/AAA:driva-ticket-42'
    ].history.map(({ text }) => text),
  ).toStrictEqual(['segunda', 'terceira']);
});

it('posts successful and failed Codex answers to the bound thread name', async () => {
  const { service, state } = await serviceWithTicketThread();
  service.messenger.auth = {
    getClient: async () => ({
      getRequestHeaders: async () => ({ Authorization: 'Bearer test' }),
    }),
  };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        name: `spaces/AAA/messages/${requests.length}`,
        thread: { name: 'spaces/AAA/threads/123' },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  try {
    service.runConversationCodex = async () => 'Resposta verificada';
    await service.answerConversation('spaces/AAA:driva-ticket-42', 'Pergunta');
    service.runConversationCodex = async () => {
      throw new Error('falha controlada');
    };
    await service.answerConversation(
      'spaces/AAA:driva-ticket-42',
      'Outra pergunta',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(requests.map(({ body }) => body)).toStrictEqual([
    { text: 'Resposta verificada', thread: { name: 'spaces/AAA/threads/123' } },
    {
      text: 'Não consegui concluir essa análise agora. Tente novamente em instantes.',
      thread: { name: 'spaces/AAA/threads/123' },
    },
  ]);
  expect(
    state.files['chat-ticket-threads.json'][
      'spaces/AAA:driva-ticket-42'
    ].history.at(-1).text,
  ).toBe('Resposta verificada');
});
