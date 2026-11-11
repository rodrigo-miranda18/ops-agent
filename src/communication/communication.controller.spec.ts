import { describe, expect, it, vi } from 'vitest';
import type { ClickUpService } from '../clickup/clickup.service.js';
import type { GoogleChatMessengerService } from '../google-chat/google-chat-messenger.service.js';
import { CommunicationController } from './communication.controller.js';
import type { CommunicationExecutionService } from './communication-execution.service.js';
import type { CommunicationStore } from './communication-store.js';

function build() {
  const getTask = vi.fn().mockResolvedValue({
    id: '901',
    custom_id: 'TICKET-10001',
    name: 'Exportação de leads',
    url: 'https://app.clickup.com/t/901',
    team_id: '90000000001',
  });
  const sendMessage = vi.fn().mockResolvedValue({
    messageName: 'm1',
    threadName: 'spaces/pd/threads/t1',
  });
  const create = vi.fn().mockResolvedValue({ id: 'comm-1' });
  const start = vi.fn().mockResolvedValue(undefined);
  const controller = new CommunicationController(
    { getTask } as unknown as ClickUpService,
    { create } as unknown as CommunicationStore,
    { start } as unknown as CommunicationExecutionService,
    {
      sendMessage,
      normalizeSpaceName: (space: string) =>
        space.startsWith('spaces/') ? space : `spaces/${space}`,
    } as unknown as GoogleChatMessengerService,
  );
  return { controller, getTask, sendMessage, create, start };
}

describe('CommunicationController', () => {
  it('starts an API-origin communication delivered to the given space', async () => {
    const { controller, getTask, sendMessage, create, start } = build();

    const response = await controller.create({
      ticketId: 'https://app.clickup.com/t/90000000001/TICKET-10001',
      deliverySpace: 'SPACE_ID_3',
    });

    expect(getTask).toHaveBeenCalledWith('TICKET-10001', '90000000001');
    expect(sendMessage).toHaveBeenCalledWith(
      'spaces/SPACE_ID_3',
      { text: 'Comunicação - Exportação de leads' },
      { threadKey: 'driva-ticket-901' },
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        apiOrigin: true,
        space: 'spaces/SPACE_ID_3',
        threadName: 'spaces/pd/threads/t1',
        task: expect.objectContaining({
          id: '901',
          name: 'Exportação de leads',
        }),
      }),
    );
    expect(start).toHaveBeenCalledWith({
      communicationId: 'comm-1',
      version: 1,
    });
    expect(response).toEqual({ communicationId: 'comm-1', status: 'queued' });
  });

  it('rejects a ticketId that is not a ClickUp link', async () => {
    const { controller, getTask } = build();
    await expect(
      controller.create({ ticketId: 'not-a-link', deliverySpace: 'spaces/pd' }),
    ).rejects.toThrow();
    expect(getTask).not.toHaveBeenCalled();
  });

  it('fails when Google Chat does not confirm the thread', async () => {
    const { controller, sendMessage, create } = build();
    sendMessage.mockResolvedValueOnce({
      messageName: 'm1',
      threadName: undefined,
    });
    await expect(
      controller.create({
        ticketId: 'https://app.clickup.com/t/90000000001/TICKET-10001',
        deliverySpace: 'spaces/pd',
      }),
    ).rejects.toThrow('não confirmou a thread');
    expect(create).not.toHaveBeenCalled();
  });
});
