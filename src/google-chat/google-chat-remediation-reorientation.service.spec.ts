import { expect, it } from 'vitest';
import { googleChatConfig } from '../config/google-chat-config.js';
import { runtimeConfig } from '../config/runtime-config.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';
import { GoogleChatRemediationReorientationService } from './google-chat-remediation-reorientation.service.js';
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

function reorientationService(
  state,
  executions,
  messenger = new GoogleChatMessengerService(chatConfig()),
) {
  return new GoogleChatRemediationReorientationService(
    state,
    executions,
    messenger,
    chatConfig(),
    runtimeConfig({}, process.cwd()),
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

it('creates a confirmation only when the user quotes the latest technical-action message', async () => {
  // Arrange
  const { threads, state } = await threadsWithTicketThread();
  await threads.bindTicketThread({
    space: 'spaces/AAA',
    threadName: 'spaces/AAA/threads/123',
    taskId: '42',
    ticketName: 'TICKET-42 — Falha no relatório',
    ticketUrl: 'https://app.clickup.com/t/42',
    remediationMessageName: 'spaces/AAA/messages/action-2',
  });
  const reorientation = reorientationService(state, {});
  const event = ticketThreadEvent(
    'users/1',
    'Remova a alteração no serviço B.',
  );
  event.user.displayName = 'Pessoa 1';
  event.message.quotedMessageMetadata = {
    name: 'spaces/AAA/messages/action-2',
  };

  // Act
  const response = await reorientation.handle(event);

  // Assert
  expect(response.handled).toBe(true);
  expect(
    JSON.stringify(response.response).includes('Confirmar reorientação'),
  ).toBe(true);
  const request = Object.values(
    state.files['remediation-reorientations.json'],
  )[0];
  expect(request.instruction).toBe('Remova a alteração no serviço B.');
  expect(request.status).toBe('pending_confirmation');
});

it('leaves replies to older technical-action messages in the read-only conversation flow', async () => {
  // Arrange
  const { threads, state } = await threadsWithTicketThread();
  await threads.bindTicketThread({
    space: 'spaces/AAA',
    threadName: 'spaces/AAA/threads/123',
    taskId: '42',
    ticketName: 'TICKET-42 — Falha no relatório',
    ticketUrl: null,
    remediationMessageName: 'spaces/AAA/messages/action-latest',
  });
  const reorientation = reorientationService(state, {});
  const event = ticketThreadEvent('users/1', 'Explique esta decisão.');
  event.message.quotedMessageMetadata = {
    name: 'spaces/AAA/messages/action-old',
  };

  // Act
  const response = await reorientation.handle(event);

  // Assert
  expect(response).toStrictEqual({ handled: false });
  expect(state.files['remediation-reorientations.json']).toBe(undefined);
});

it('recognizes a pre-deployment technical-action message from notification history', async () => {
  // Arrange
  const { state } = await threadsWithTicketThread();
  state.files['notifications.json'] = {
    '42:2026-08-29:remediation:spaces/AAA': {
      status: 'sent',
      messageName: 'spaces/AAA/messages/legacy-action',
      sentAt: '2026-08-29T12:00:00.000Z',
    },
  };
  const reorientation = reorientationService(state, {});
  const event = ticketThreadEvent('users/1', 'Simplifique a correção.');
  event.message.quotedMessageMetadata = {
    name: 'spaces/AAA/messages/legacy-action',
  };

  // Act
  const response = await reorientation.handle(event);

  // Assert
  expect(response.handled).toBe(true);
  expect(
    Object.values(state.files['remediation-reorientations.json'])[0]
      .instruction,
  ).toBe('Simplifique a correção.');
});

it('only the requester can confirm and enqueue a remediation reorientation', async () => {
  // Arrange
  const state = new MemoryState();
  state.files['remediation-reorientations.json'] = {
    'request-1': {
      id: 'request-1',
      iteration: 1,
      ticketId: '42',
      ticketName: 'TICKET-42',
      space: 'spaces/AAA',
      threadName: 'spaces/AAA/threads/123',
      quotedMessageName: 'spaces/AAA/messages/action',
      instruction: 'Use apenas o serviço A.',
      requestedBy: 'users/1',
      requestedByLabel: 'Pessoa 1',
      status: 'pending_confirmation',
      createdAt: new Date().toISOString(),
    },
  };
  const enqueued = [];
  const reorientation = reorientationService(
    state,
    {
      enqueueReorientation: (id) => {
        enqueued.push(id);
        return Promise.resolve();
      },
    },
    { sendText: async () => undefined },
  );
  const actionEvent = (userName) => ({
    type: 'CARD_CLICKED',
    space: { name: 'spaces/AAA' },
    user: { name: userName },
    message: { thread: { name: 'spaces/AAA/threads/123' } },
    commonEventObject: {
      parameters: {
        action: 'confirm_remediation_reorientation',
        reorientationId: 'request-1',
      },
    },
  });

  // Act
  const rejected = await reorientation.handle(actionEvent('users/2'));
  const accepted = await reorientation.handle(actionEvent('users/1'));

  // Assert
  expect(rejected.response.text).toBe(
    'Somente quem enviou a nova orientação pode confirmá-la ou cancelá-la.',
  );
  expect(
    accepted.response.text.includes('Reorientação confirmada e enfileirada.'),
  ).toBe(true);
  expect(enqueued).toStrictEqual(['request-1']);
  expect(
    state.files['remediation-reorientations.json']['request-1'].status,
  ).toBe('queued');
});

it('expires an abandoned confirmation without enqueueing remediation', async () => {
  // Arrange
  const state = new MemoryState();
  state.files['remediation-reorientations.json'] = {
    'request-old': {
      id: 'request-old',
      iteration: 1,
      ticketId: '42',
      ticketName: 'TICKET-42',
      space: 'spaces/AAA',
      threadName: 'spaces/AAA/threads/123',
      quotedMessageName: 'spaces/AAA/messages/action',
      instruction: 'Use apenas o serviço A.',
      requestedBy: 'users/1',
      requestedByLabel: 'Pessoa 1',
      status: 'pending_confirmation',
      createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    },
  };
  const enqueued = [];
  const reorientation = reorientationService(
    state,
    {
      enqueueReorientation: (id) => {
        enqueued.push(id);
        return Promise.resolve();
      },
    },
    { sendText: async () => undefined },
  );
  const event = {
    type: 'CARD_CLICKED',
    space: { name: 'spaces/AAA' },
    user: { name: 'users/1' },
    message: { thread: { name: 'spaces/AAA/threads/123' } },
    commonEventObject: {
      parameters: {
        action: 'confirm_remediation_reorientation',
        reorientationId: 'request-old',
      },
    },
  };

  // Act
  const response = await reorientation.handle(event);

  // Assert
  expect(response.response.text).toBe(
    'Esta confirmação expirou. Responda novamente à mensagem de Ação técnica.',
  );
  expect(enqueued).toStrictEqual([]);
  expect(
    state.files['remediation-reorientations.json']['request-old'].status,
  ).toBe('cancelled');
});
