import { Injectable } from '@nestjs/common';
import { StateService } from '../state/state.service.js';
import type { TicketThreadState } from './google-chat.types.js';
import {
  ticketThreadBindingKey,
  ticketThreadKey,
} from './google-chat-threading.js';

@Injectable()
export class GoogleChatThreadsService {
  constructor(private readonly state: StateService) {}

  async bindTicketThread(input: {
    space: string;
    taskId: string;
    ticketName: string;
    ticketUrl: string | null;
    threadName?: string;
    approvalId?: string;
    remediationMessageName?: string;
  }) {
    const now = new Date().toISOString();
    const key = ticketThreadBindingKey(input.space, input.taskId);
    const state = await this.state.update<TicketThreadState>(
      'chat-ticket-threads.json',
      (current) => {
        const existing = current[key];
        current[key] = {
          space: input.space,
          threadName: existing?.threadName || input.threadName,
          threadKey: existing?.threadKey || ticketThreadKey(input.taskId),
          taskId: input.taskId,
          ticketName: input.ticketName,
          ticketUrl: input.ticketUrl,
          approvalId: input.approvalId || existing?.approvalId,
          remediationMessageName:
            input.remediationMessageName || existing?.remediationMessageName,
          createdAt: existing?.createdAt || now,
          lastActiveAt: existing?.lastActiveAt || now,
          history: existing?.history || [],
        };
      },
    );
    return state[key];
  }
}
