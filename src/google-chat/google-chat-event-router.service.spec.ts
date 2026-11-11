import { expect, it } from 'vitest';
import { clickUpConfig } from '../config/clickup-config.js';
import { googleChatConfig } from '../config/google-chat-config.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { GoogleChatActionsService } from './google-chat-actions.service.js';
import { GoogleChatConversationService } from './google-chat-conversation.service.js';
import { GoogleChatEventRouterService } from './google-chat-event-router.service.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';
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

function eventRouter(
  state,
  communicationActions = { handleAction: async () => ({ text: 'unused' }) },
  communicationThread = { handleMessage: async () => null },
) {
  const config = chatConfig();
  const messenger = new GoogleChatMessengerService(config);
  return new GoogleChatEventRouterService(
    new GoogleChatActionsService(
      state,
      {},
      {},
      messenger,
      config,
      clickUpConfig({}),
    ),
    new GoogleChatConversationService(
      state,
      messenger,
      config,
      runtimeConfig({}, process.cwd()),
    ),
    communicationActions,
    communicationThread,
  );
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

async function serviceWithTicketThread() {
  const state = new MemoryState();
  const service = eventRouter(state);
  const threads = new GoogleChatThreadsService(state);
  await threads.bindTicketThread({
    space: 'spaces/AAA',
    threadName: 'spaces/AAA/threads/123',
    taskId: '42',
    ticketName: 'TICKET-42 — Falha no relatório',
    ticketUrl: 'https://app.clickup.com/t/42',
  });
  return { service, state };
}

it('queues questions from different users against the same ticket thread and replies in place', async () => {
  const { service, state } = await serviceWithTicketThread();
  const queued = [];
  service.conversation.enqueueConversation = (bindingKey, text) =>
    queued.push({ bindingKey, text });

  const first = await service.handleEvent(
    ticketThreadEvent('users/1', 'Qual foi a causa?'),
  );
  const second = await service.handleEvent(
    ticketThreadEvent('users/2', 'Existe plano de ação?'),
  );

  expect(first).toStrictEqual({
    text: 'Recebi sua pergunta. Vou analisar o diagnóstico e responder aqui.',
    thread: { name: 'spaces/AAA/threads/123' },
  });
  expect(second.thread).toStrictEqual({ name: 'spaces/AAA/threads/123' });
  expect(queued).toStrictEqual([
    { bindingKey: 'spaces/AAA:driva-ticket-42', text: 'Qual foi a causa?' },
    { bindingKey: 'spaces/AAA:driva-ticket-42', text: 'Existe plano de ação?' },
  ]);
  expect(
    state.files['chat-ticket-threads.json'][
      'spaces/AAA:driva-ticket-42'
    ].history.map(({ role, text }) => ({ role, text })),
  ).toStrictEqual([
    { role: 'user', text: 'Qual foi a causa?' },
    { role: 'user', text: 'Existe plano de ação?' },
  ]);
});

it('does not queue Codex for an unmapped thread', async () => {
  const { service } = await serviceWithTicketThread();
  let queued = false;
  service.conversation.enqueueConversation = () => {
    queued = true;
  };

  const response = await service.handleEvent(
    ticketThreadEvent(
      'users/1',
      'Pergunta fora do ticket',
      'spaces/AAA/threads/other',
    ),
  );

  expect(queued).toBe(false);
  expect(response).toStrictEqual({
    text: 'Esta thread não está vinculada a um ticket. Envie a pergunta na thread criada pelo diagnóstico do ticket.',
    thread: { name: 'spaces/AAA/threads/other' },
  });
});

it('routes communication actions and communication thread messages to the communication services', async () => {
  const state = new MemoryState();
  const handled = [];
  const service = eventRouter(
    state,
    {
      handleAction: async (event) => {
        handled.push(['action', event.commonEventObject.invokedFunction]);
        return { text: 'Versão 1 publicada.' };
      },
    },
    {
      handleMessage: async (event) => {
        handled.push(['thread', event.message.text]);
        return event.message.thread.name === 'spaces/DM/threads/c'
          ? { text: 'Gerando a versão 2 com o seu ajuste…' }
          : null;
      },
    },
  );

  const action = await service.handleEvent({
    commonEventObject: {
      invokedFunction: 'communication_approve',
      parameters: { communicationId: 'c1', version: '1' },
    },
    space: { name: 'spaces/DM' },
    message: { thread: { name: 'spaces/DM/threads/c' } },
  });
  const feedback = await service.handleEvent(
    ticketThreadEvent('users/pm', 'mais curto', 'spaces/DM/threads/c'),
  );

  expect(action).toStrictEqual({
    text: 'Versão 1 publicada.',
    thread: { name: 'spaces/DM/threads/c' },
  });
  expect(feedback).toStrictEqual({
    text: 'Gerando a versão 2 com o seu ajuste…',
    thread: { name: 'spaces/DM/threads/c' },
  });
  expect(handled).toStrictEqual([
    ['action', 'communication_approve'],
    ['thread', 'mais curto'],
  ]);
});
