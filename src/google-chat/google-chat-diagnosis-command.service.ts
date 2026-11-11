import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  clickUpCommandError,
  parseClickUpLink,
} from '../clickup/clickup-link.js';
import { ClickUpService } from '../clickup/clickup.service.js';
import { DiagnosisExecutionService } from '../diagnosis/diagnosis-execution.service.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';
import { GoogleChatThreadsService } from './google-chat-threads.service.js';
import type { ChatEvent } from './google-chat.types.js';
import {
  chatCommandId,
  chatCommandMessage,
  chatCommandReply,
  chatCommandSpaceName,
} from './google-chat-add-on.js';
import {
  GOOGLE_CHAT_CONFIG,
  type GoogleChatConfig,
} from '../config/google-chat-config.js';

@Injectable()
export class GoogleChatDiagnosisCommandService {
  private readonly logger = new Logger(GoogleChatDiagnosisCommandService.name);

  constructor(
    private readonly clickUp: ClickUpService,
    private readonly executions: DiagnosisExecutionService,
    private readonly threads: GoogleChatThreadsService,
    private readonly messenger: GoogleChatMessengerService,
    @Inject(GOOGLE_CHAT_CONFIG) private readonly config: GoogleChatConfig,
  ) {}

  async handle(
    event: ChatEvent,
  ): Promise<{ handled: boolean; response?: unknown }> {
    const message = chatCommandMessage(event);
    const text = (message?.argumentText || message?.text || '').trim();
    const commandId = chatCommandId(event);
    const configuredCommandId = this.config.processCommandId;
    const isCommand =
      commandId !== undefined
        ? commandId === configuredCommandId
        : /^\/processar(?:\s|$)/i.test(text);
    if (!isCommand) return { handled: false };

    const space = chatCommandSpaceName(event);
    if (!space)
      return this.reply(event, 'Não foi possível identificar a conversa.');
    const threadName = message?.thread?.name;

    try {
      const reference = parseClickUpLink(text);
      const task = await this.clickUp.getTask(
        reference.taskId,
        reference.teamId,
      );
      const ticketId = String(task.id || '').trim();
      if (!ticketId)
        throw new Error('O ClickUp não retornou o ID interno do ticket.');
      if (threadName) {
        await this.threads.bindTicketThread({
          space,
          threadName,
          taskId: ticketId,
          ticketName: ticketLabel(task, reference.taskId),
          ticketUrl: typeof task.url === 'string' ? task.url : null,
        });
      }

      const active = await this.executions.findActiveByTicket(ticketId);
      if (active) {
        return this.reply(
          event,
          `O ticket **${ticketLabel(task, reference.taskId)}** já está sendo processado. Run: \`${active.runId}\`.`,
        );
      }

      const { runId, completion } = await this.executions.enqueue({
        ticketId,
        source: 'manual',
        force: true,
        notify: true,
        remediation: 'auto',
        googleChatSpace: space,
        googleChatThread: threadName,
      });
      void completion.catch(async (error) => {
        this.logger.error(
          `Google Chat manual run failed: run=${runId} ticket=${ticketId} error=${(error as Error).message}`,
        );
        try {
          await this.messenger.sendText(
            space,
            `Não consegui processar o ticket **${ticketLabel(task, reference.taskId)}**. Run: \`${runId}\`.`,
            threadName,
          );
        } catch (notificationError) {
          this.logger.error(
            `Could not notify Google Chat run failure: run=${runId} error=${(notificationError as Error).message}`,
          );
        }
      });

      return this.reply(
        event,
        `Processamento de **${ticketLabel(task, reference.taskId)}** enfileirado. Run: \`${runId}\`.`,
      );
    } catch (error) {
      this.logger.warn(
        `Google Chat process command rejected: ${(error as Error).message}`,
      );
      return this.reply(event, clickUpCommandError(error));
    }
  }

  private reply(event: ChatEvent, text: string) {
    return chatCommandReply(event, text);
  }
}

function ticketLabel(task: Record<string, unknown>, fallback: string) {
  const id = String(task.custom_id || task.id || fallback);
  const name = String(task.name || '').trim();
  return name ? `${id} — ${name}` : id;
}
