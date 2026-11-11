import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ticketResultsDir } from '../diagnosis/diagnosis-artifacts.js';
import { DiagnosisExecutionService } from '../diagnosis/diagnosis-execution.service.js';
import type { ReorientationStatus } from '../remediation/reorientation-status.js';
import { StateService } from '../state/state.service.js';
import type { ChatEvent } from './google-chat.types.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';
import {
  GOOGLE_CHAT_CONFIG,
  requireGoogleChatActionUrl,
  type GoogleChatConfig,
} from '../config/google-chat-config.js';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';

interface TicketThreadRecord {
  space: string;
  threadName?: string;
  taskId: string;
  ticketName: string;
  remediationMessageName?: string;
}

interface RemediationReorientationRecord {
  id: string;
  iteration: number;
  ticketId: string;
  ticketName: string;
  space: string;
  threadName: string;
  quotedMessageName: string;
  instruction: string;
  requestedBy: string;
  requestedByLabel: string;
  status: ReorientationStatus;
  createdAt: string;
  confirmedAt?: string;
  finishedAt?: string;
  error?: string;
}

type TicketThreadState = Record<string, TicketThreadRecord>;
type RemediationReorientationState = Record<
  string,
  RemediationReorientationRecord
>;

@Injectable()
export class GoogleChatRemediationReorientationService {
  private readonly logger = new Logger(
    GoogleChatRemediationReorientationService.name,
  );

  constructor(
    private readonly state: StateService,
    private readonly executions: DiagnosisExecutionService,
    private readonly messenger: GoogleChatMessengerService,
    @Inject(GOOGLE_CHAT_CONFIG) private readonly config: GoogleChatConfig,
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
  ) {}

  async handle(
    event: ChatEvent,
  ): Promise<{ handled: boolean; response?: unknown }> {
    const invokedFunction = invokedAction(event);
    if (
      [
        'confirm_remediation_reorientation',
        'cancel_remediation_reorientation',
      ].includes(invokedFunction || '')
    ) {
      return this.handleConfirmation(event, invokedFunction!);
    }

    const message = sourceMessage(event);
    const quotedMessageName = message?.quotedMessageMetadata?.name;
    if (!quotedMessageName) return { handled: false };
    const space = sourceSpace(event);
    const threadName = message?.thread?.name;
    const user = sourceUser(event);
    const instruction = (message?.argumentText || message?.text || '').trim();
    if (!space || !threadName || !user?.name) return { handled: false };

    const threads = await this.state.read<TicketThreadState>(
      'chat-ticket-threads.json',
    );
    const ticketThread = Object.values(threads).find(
      (thread) => thread.space === space && thread.threadName === threadName,
    );
    if (
      !ticketThread ||
      !(await this.isCurrentTechnicalActionMessage(
        ticketThread,
        quotedMessageName,
      ))
    )
      return { handled: false };
    if (!instruction)
      return this.reply(event, {
        text: 'Escreva a nova orientação ao responder à mensagem de Ação técnica.',
      });
    if (instruction.length > this.config.reorientationMaxMessageLength) {
      return this.reply(event, {
        text: `A orientação ultrapassa ${this.config.reorientationMaxMessageLength} caracteres. Envie uma versão mais curta.`,
      });
    }

    const id = randomUUID();
    let created!: RemediationReorientationRecord;
    let existing: RemediationReorientationRecord | undefined;
    await this.state.update<RemediationReorientationState>(
      'remediation-reorientations.json',
      (records) => {
        for (const record of Object.values(records)) {
          if (
            record.status === 'pending_confirmation' &&
            confirmationExpired(
              record,
              this.config.reorientationConfirmationMinutes,
            )
          )
            record.status = 'cancelled';
        }
        existing = Object.values(records).find(
          (record) =>
            record.ticketId === ticketThread.taskId &&
            ['pending_confirmation', 'queued', 'running'].includes(
              record.status,
            ),
        );
        if (existing) return;
        const iteration =
          Math.max(
            0,
            ...Object.values(records)
              .filter((record) => record.ticketId === ticketThread.taskId)
              .map((record) => record.iteration || 0),
          ) + 1;
        created = records[id] = {
          id,
          iteration,
          ticketId: ticketThread.taskId,
          ticketName: ticketThread.ticketName,
          space,
          threadName,
          quotedMessageName,
          instruction,
          requestedBy: user.name!,
          requestedByLabel: user.displayName || user.email || user.name!,
          status: 'pending_confirmation',
          createdAt: new Date().toISOString(),
        };
      },
    );
    if (existing) {
      return this.reply(event, {
        text: `Já existe uma reorientação ${existing.status === 'pending_confirmation' ? 'aguardando confirmação' : 'em processamento'} para este ticket.`,
      });
    }

    const previousPullRequests = await this.previousPullRequests(
      ticketThread.taskId,
    );
    this.logger.log(
      `Remediation reorientation awaiting confirmation: id=${id} ticket=${ticketThread.taskId} user=${user.name}`,
    );
    return this.reply(
      event,
      confirmationCard(
        created,
        previousPullRequests,
        requireGoogleChatActionUrl(this.config.actionUrl),
      ),
    );
  }

  private async handleConfirmation(event: ChatEvent, action: string) {
    const id = actionParameters(event).reorientationId;
    const user = sourceUser(event);
    const space = sourceSpace(event);
    if (!id || !user?.name || !space)
      return this.reply(event, {
        text: 'Confirmação de reorientação inválida.',
      });

    const records = await this.state.read<RemediationReorientationState>(
      'remediation-reorientations.json',
    );
    const request = records[id];
    if (!request)
      return this.reply(event, {
        text: 'Esta reorientação não existe ou expirou.',
      });
    if (request.space !== space || request.requestedBy !== user.name) {
      return this.reply(event, {
        text: 'Somente quem enviou a nova orientação pode confirmá-la ou cancelá-la.',
      });
    }
    if (
      request.status === 'pending_confirmation' &&
      confirmationExpired(request, this.config.reorientationConfirmationMinutes)
    ) {
      await this.state.update<RemediationReorientationState>(
        'remediation-reorientations.json',
        (current) => {
          if (current[id]?.status === 'pending_confirmation')
            current[id].status = 'cancelled';
        },
      );
      return this.reply(event, {
        text: 'Esta confirmação expirou. Responda novamente à mensagem de Ação técnica.',
      });
    }
    if (request.status !== 'pending_confirmation') {
      return this.reply(event, {
        text:
          request.status === 'cancelled'
            ? 'Esta reorientação já foi cancelada.'
            : 'Esta reorientação já foi confirmada.',
      });
    }

    if (action === 'cancel_remediation_reorientation') {
      await this.state.update<RemediationReorientationState>(
        'remediation-reorientations.json',
        (current) => {
          if (current[id]?.status === 'pending_confirmation')
            current[id].status = 'cancelled';
        },
      );
      return this.reply(event, {
        text: 'Reorientação cancelada. Nenhum PR foi alterado.',
      });
    }

    let queued = false;
    await this.state.update<RemediationReorientationState>(
      'remediation-reorientations.json',
      (current) => {
        if (current[id]?.status !== 'pending_confirmation') return;
        current[id].status = 'queued';
        current[id].confirmedAt = new Date().toISOString();
        queued = true;
      },
    );
    if (!queued)
      return this.reply(event, {
        text: 'Esta reorientação já foi confirmada.',
      });

    const completion = this.executions.enqueueReorientation(id);
    void completion.catch(async (error) => {
      this.logger.error(
        `Remediation reorientation failed: id=${id} ticket=${request.ticketId} error=${(error as Error).message}`,
      );
      try {
        await this.messenger.sendText(
          request.space,
          `Não consegui concluir a reorientação de **${request.ticketName}**. Os PRs anteriores foram preservados.`,
          request.threadName,
        );
      } catch (notificationError) {
        this.logger.error(
          `Could not notify reorientation failure: id=${id} error=${(notificationError as Error).message}`,
        );
      }
    });
    return this.reply(event, {
      text: `Reorientação confirmada e enfileirada. Iteração ${request.iteration}. Os PRs anteriores só serão fechados após a criação bem-sucedida dos substitutos.`,
    });
  }

  private async isCurrentTechnicalActionMessage(
    ticketThread: TicketThreadRecord,
    quotedMessageName: string,
  ) {
    if (ticketThread.remediationMessageName)
      return ticketThread.remediationMessageName === quotedMessageName;
    const notifications =
      await this.state.read<
        Record<
          string,
          { status?: string; messageName?: string | null; sentAt?: string }
        >
      >('notifications.json');
    const legacyRemediationMessages = Object.entries(notifications)
      .filter(
        ([key, record]) =>
          key.startsWith(`${ticketThread.taskId}:`) &&
          key.includes(`:remediation:${ticketThread.space}`) &&
          record.status === 'sent' &&
          record.messageName,
      )
      .sort((left, right) =>
        String(right[1].sentAt || '').localeCompare(
          String(left[1].sentAt || ''),
        ),
      );
    return legacyRemediationMessages[0]?.[1].messageName === quotedMessageName;
  }

  private async previousPullRequests(ticketId: string) {
    try {
      const ticketDir = ticketResultsDir(this.runtime.resultsDir, ticketId);
      const remediation = JSON.parse(
        await readFile(path.join(ticketDir, 'remediation.json'), 'utf8'),
      ) as { pull_requests?: Array<{ repository?: string; url?: string }> };
      return (
        remediation.pull_requests?.filter((pullRequest) => pullRequest.url) ||
        []
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private reply(event: ChatEvent, message: Record<string, unknown>) {
    const threadName = sourceMessage(event)?.thread?.name;
    const threadedMessage = threadName
      ? { ...message, thread: { name: threadName } }
      : message;
    const response = event.chat
      ? {
          hostAppDataAction: {
            chatDataAction: {
              createMessageAction: { message: threadedMessage },
            },
          },
        }
      : threadedMessage;
    return { handled: true, response };
  }
}

function sourceMessage(event: ChatEvent) {
  return (
    event.message ||
    event.chat?.messagePayload?.message ||
    event.chat?.buttonClickedPayload?.message
  );
}

function sourceSpace(event: ChatEvent) {
  return (
    event.space?.name ||
    event.chat?.space?.name ||
    event.chat?.messagePayload?.space?.name ||
    event.chat?.buttonClickedPayload?.space?.name
  );
}

function sourceUser(event: ChatEvent) {
  return event.user || event.chat?.user || sourceMessage(event)?.sender;
}

function invokedAction(event: ChatEvent) {
  return (
    event.commonEventObject?.parameters?.action ||
    event.commonEventObject?.invokedFunction ||
    event.action?.actionMethodName
  );
}

function actionParameters(event: ChatEvent) {
  return {
    ...Object.fromEntries(
      (event.action?.parameters || []).map(({ key, value }) => [key, value]),
    ),
    ...(event.commonEventObject?.parameters || {}),
  };
}

function confirmationCard(
  request: RemediationReorientationRecord,
  previousPullRequests: Array<{ repository?: string; url?: string }>,
  actionFunction: string,
) {
  const pullRequests = previousPullRequests.length
    ? previousPullRequests
        .map(
          (pullRequest) =>
            `• ${escapeText(pullRequest.repository || pullRequest.url || 'PR')}`,
        )
        .join('<br>')
    : 'Nenhum PR anterior registrado.';
  return {
    cardsV2: [
      {
        cardId: `confirm-remediation-reorientation-${request.id}`,
        card: {
          header: {
            title: '🔄 Confirmar reorientação',
            subtitle: `${request.ticketName} · iteração ${request.iteration}`,
          },
          sections: [
            {
              widgets: [
                {
                  textParagraph: {
                    text: `<b>Nova orientação</b><br>${escapeText(request.instruction)}`,
                  },
                },
              ],
            },
            {
              widgets: [
                {
                  textParagraph: {
                    text: `<b>PRs que podem ser substituídos</b><br>${pullRequests}`,
                  },
                },
              ],
            },
            {
              widgets: [
                {
                  textParagraph: {
                    text: 'Os PRs anteriores serão fechados somente depois que os substitutos forem criados com sucesso.',
                  },
                },
              ],
            },
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Confirmar reorientação',
                        onClick: {
                          action: {
                            function: actionFunction,
                            parameters: [
                              {
                                key: 'action',
                                value: 'confirm_remediation_reorientation',
                              },
                              { key: 'reorientationId', value: request.id },
                            ],
                          },
                        },
                      },
                      {
                        text: 'Cancelar',
                        onClick: {
                          action: {
                            function: actionFunction,
                            parameters: [
                              {
                                key: 'action',
                                value: 'cancel_remediation_reorientation',
                              },
                              { key: 'reorientationId', value: request.id },
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function escapeText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function confirmationExpired(
  record: RemediationReorientationRecord,
  ttlMinutes: number,
) {
  const createdAt = new Date(record.createdAt).getTime();
  return (
    !Number.isFinite(createdAt) || Date.now() - createdAt > ttlMinutes * 60_000
  );
}
