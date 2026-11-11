import { expect, it } from 'vitest';
import { GoogleChatThreadsService } from './google-chat-threads.service.js';

class MemoryState {
  files = {};

  async update(name, mutate) {
    const value = this.files[name] || {};
    mutate(value);
    this.files[name] = value;
    return value;
  }
}

const TICKET = {
  space: 'spaces/AAA',
  taskId: '42',
  ticketName: 'Falha no envio',
  ticketUrl: 'https://app.clickup.com/t/42',
};

it('creates a binding keyed by space and task with the ticket thread key', async () => {
  const state = new MemoryState();
  const threads = new GoogleChatThreadsService(state);

  const binding = await threads.bindTicketThread({
    ...TICKET,
    threadName: 'spaces/AAA/threads/1',
    approvalId: 'approval-1',
  });

  expect(binding).toMatchObject({
    ...TICKET,
    threadName: 'spaces/AAA/threads/1',
    threadKey: 'driva-ticket-42',
    approvalId: 'approval-1',
    history: [],
  });
  expect(binding.createdAt).toBe(binding.lastActiveAt);
  expect(state.files['chat-ticket-threads.json']).toStrictEqual({
    'spaces/AAA:driva-ticket-42': binding,
  });
});

it('keeps the existing thread, dates and history when rebinding', async () => {
  const state = new MemoryState();
  const history = [{ role: 'user', text: 'oi', at: '2026-01-01' }];
  state.files['chat-ticket-threads.json'] = {
    'spaces/AAA:driva-ticket-42': {
      ...TICKET,
      threadName: 'spaces/AAA/threads/old',
      threadKey: 'custom-key',
      approvalId: 'approval-old',
      remediationMessageName: 'spaces/AAA/messages/old',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-02T00:00:00.000Z',
      history,
    },
  };
  const threads = new GoogleChatThreadsService(state);

  const binding = await threads.bindTicketThread({
    ...TICKET,
    ticketName: 'Novo nome',
    threadName: 'spaces/AAA/threads/new',
  });

  expect(binding).toStrictEqual({
    ...TICKET,
    ticketName: 'Novo nome',
    threadName: 'spaces/AAA/threads/old',
    threadKey: 'custom-key',
    approvalId: 'approval-old',
    remediationMessageName: 'spaces/AAA/messages/old',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-02T00:00:00.000Z',
    history,
  });
});

it('overrides approval and remediation message when provided', async () => {
  const state = new MemoryState();
  const threads = new GoogleChatThreadsService(state);
  await threads.bindTicketThread({ ...TICKET, approvalId: 'approval-old' });

  const binding = await threads.bindTicketThread({
    ...TICKET,
    approvalId: 'approval-new',
    remediationMessageName: 'spaces/AAA/messages/2',
  });

  expect(binding.approvalId).toBe('approval-new');
  expect(binding.remediationMessageName).toBe('spaces/AAA/messages/2');
});
