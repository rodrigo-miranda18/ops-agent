import { Injectable } from '@nestjs/common';
import { CommunicationActionsService } from '../communication/communication-actions.service.js';
import { CommunicationThreadService } from '../communication/communication-thread.service.js';
import { GoogleChatActionsService } from './google-chat-actions.service.js';
import { GoogleChatConversationService } from './google-chat-conversation.service.js';
import type { ChatEvent } from './google-chat.types.js';
import {
  addOnMessageResponse,
  normalizeAddOnChatEvent,
} from './google-chat-add-on.js';

const COMMUNICATION_ACTION_PREFIX = 'communication_';

@Injectable()
export class GoogleChatEventRouterService {
  constructor(
    private readonly actions: GoogleChatActionsService,
    private readonly conversation: GoogleChatConversationService,
    private readonly communicationActions: CommunicationActionsService,
    private readonly communicationThread: CommunicationThreadService,
  ) {}

  async handleEvent(event: ChatEvent) {
    const addOnEvent = Boolean(event.chat);
    const normalizedEvent = addOnEvent ? normalizeAddOnChatEvent(event) : event;
    const invokedFunction =
      normalizedEvent.commonEventObject?.invokedFunction ||
      normalizedEvent.action?.actionMethodName;
    const response = invokedFunction
      ? invokedFunction.startsWith(COMMUNICATION_ACTION_PREFIX)
        ? await this.communicationActions.handleAction(normalizedEvent)
        : await this.actions.handleAction(normalizedEvent)
      : normalizedEvent.type === 'MESSAGE' || normalizedEvent.message
        ? ((await this.communicationThread.handleMessage(normalizedEvent)) ??
          (await this.conversation.handleMessage(normalizedEvent)))
        : { text: 'Evento não reconhecido.' };
    const threadName = normalizedEvent.message?.thread?.name;
    const threadedResponse = threadName
      ? { ...response, thread: { name: threadName } }
      : response;
    return addOnEvent
      ? addOnMessageResponse(threadedResponse)
      : threadedResponse;
  }
}
