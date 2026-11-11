import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  clickUpCommandError,
  parseClickUpLink,
} from '../clickup/clickup-link.js';
import { ClickUpService } from '../clickup/clickup.service.js';
import {
  GOOGLE_CHAT_CONFIG,
  type GoogleChatConfig,
} from '../config/google-chat-config.js';
import {
  chatCommandId,
  chatCommandMessage,
  chatCommandReply,
  chatCommandSpaceName,
} from '../google-chat/google-chat-add-on.js';
import { GoogleChatMessengerService } from '../google-chat/google-chat-messenger.service.js';
import type { ChatEvent } from '../google-chat/google-chat.types.js';
import { CommunicationExecutionService } from './communication-execution.service.js';
import { CommunicationStore } from './communication-store.js';
import { communicationTask } from './communication-task.js';

@Injectable()
export class CommunicationCommandService {
  private readonly logger = new Logger(CommunicationCommandService.name);

  constructor(
    private readonly clickUp: ClickUpService,
    private readonly store: CommunicationStore,
    private readonly execution: CommunicationExecutionService,
    @Inject(GOOGLE_CHAT_CONFIG) private readonly config: GoogleChatConfig,
    private readonly messenger: GoogleChatMessengerService,
  ) {}

  async handle(
    event: ChatEvent,
  ): Promise<{ handled: boolean; response?: unknown }> {
    const message = chatCommandMessage(event);
    const text = (message?.argumentText || message?.text || '').trim();
    const commandId = chatCommandId(event);
    const isCommand =
      commandId !== undefined
        ? commandId === this.config.communicationCommandId
        : /^\/comunicacao(?:\s|$)/i.test(text);
    if (!isCommand) return { handled: false };

    const space = chatCommandSpaceName(event);
    const threadName = message?.thread?.name;
    const user = event.user || event.chat?.user || message?.sender;
    if (!space || !threadName || !user?.name)
      return chatCommandReply(
        event,
        'Não foi possível identificar a conversa ou o usuário.',
      );
    if (await this.store.findByThread(threadName))
      return chatCommandReply(
        event,
        'Esta thread já tem uma comunicação. Envie /comunicacao fora dela para começar outra.',
      );

    try {
      const reference = parseClickUpLink(text);
      const clickUpTask = await this.clickUp.getTask(
        reference.taskId,
        reference.teamId,
      );
      const task = communicationTask(clickUpTask, reference.teamId);
      const sent = await this.messenger.sendMessage(
        space,
        { text: `Comunicação - ${task.name}` },
        { threadName },
      );
      if (!sent.threadName)
        throw new Error('O Google Chat não confirmou a thread da comunicação.');
      const record = await this.store.create({
        requester: {
          user: user.name,
          displayName: user.displayName || user.email || user.name,
        },
        space,
        threadName: sent.threadName,
        task,
      });
      this.logger.log(
        `Communication ${record.id} created for task ${task.id} by ${user.name} in thread ${record.threadName}`,
      );
      await this.execution.start({ communicationId: record.id, version: 1 });
      return { handled: true, response: {} };
    } catch (error) {
      this.logger.warn(
        `Google Chat communication command rejected: ${(error as Error).message}`,
      );
      return chatCommandReply(event, clickUpCommandError(error));
    }
  }
}
