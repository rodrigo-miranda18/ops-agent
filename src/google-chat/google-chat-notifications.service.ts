import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { StateService } from '../state/state.service.js';
import { ticketResultsDir } from '../diagnosis/diagnosis-artifacts.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';
import { GoogleChatThreadsService } from './google-chat-threads.service.js';
import {
  GoogleChatActionsService,
  sha256,
} from './google-chat-actions.service.js';
import type {
  ApprovalRecord,
  ApprovalState,
  EngineeringAction,
  NotificationState,
  RemediationResult,
  StoredRun,
  StoredTicket,
  TicketThreadState,
} from './google-chat.types.js';
import {
  buildDiagnosisCard,
  buildRemediationCard,
  shouldNotifyRemediation,
} from './google-chat-cards.js';
import { selectTicketThreadAddress } from './google-chat-threading.js';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import {
  GOOGLE_CHAT_CONFIG,
  type GoogleChatConfig,
} from '../config/google-chat-config.js';

@Injectable()
export class GoogleChatNotificationsService {
  private readonly logger = new Logger(GoogleChatNotificationsService.name);
  private readonly notifyAfter: Date | null;

  constructor(
    private readonly state: StateService,
    private readonly messenger: GoogleChatMessengerService,
    private readonly threads: GoogleChatThreadsService,
    private readonly actions: GoogleChatActionsService,
    @Inject(GOOGLE_CHAT_CONFIG) private readonly config: GoogleChatConfig,
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
  ) {
    this.notifyAfter = parseOptionalDate(config.notifyAfter);
  }

  async notifySuccessfulRuns() {
    await this.actions.retryAssumptionNotifications();
    const resultsDir = this.runtime.resultsDir;
    const entries = await readdir(resultsDir, { withFileTypes: true });
    const summary = {
      directories: 0,
      successful: 0,
      beforeCutoff: 0,
      sent: 0,
      alreadySent: 0,
      unmapped: 0,
      failed: 0,
    };
    this.logger.log(
      `Scanning Google Chat notifications in ${resultsDir}; cutoff=${this.notifyAfter?.toISOString() || 'disabled'}`,
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      summary.directories += 1;
      const ticketDir = path.join(resultsDir, entry.name);
      try {
        const run = JSON.parse(
          await readFile(path.join(ticketDir, 'run.json'), 'utf8'),
        ) as StoredRun;
        if (
          run.status !== 'success' ||
          run.notify === false ||
          run.notification_version !== 2
        )
          continue;
        summary.successful += 1;
        if (this.notifyAfter && new Date(run.finished_at) < this.notifyAfter) {
          summary.beforeCutoff += 1;
          continue;
        }
        for (const phase of ['diagnosis', 'remediation'] as const) {
          const result = await this.notifyRun(ticketDir, run, phase);
          summary.sent += result.sent;
          summary.alreadySent += result.alreadySent;
          summary.unmapped += result.unmapped;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          summary.failed += 1;
          this.logger.error(
            `Could not notify result ${entry.name}: ${(error as Error).message}`,
          );
        }
      }
    }
    this.logger.log(
      `Google Chat notification scan finished: ${JSON.stringify(summary)}`,
    );
  }

  async notifyDiagnosis(ticketId: string) {
    const ticketDir = ticketResultsDir(this.runtime.resultsDir, ticketId);
    const run = JSON.parse(
      await readFile(path.join(ticketDir, 'run.json'), 'utf8'),
    ) as StoredRun;
    if (
      run.notify === false ||
      run.notification_version !== 2 ||
      !['diagnosed', 'success'].includes(run.status)
    )
      return;
    const result = await this.notifyRun(ticketDir, run, 'diagnosis');
    if (ticketId.startsWith('grafana-') && result.unmapped)
      throw new Error(
        'No Google Chat space configured for the diagnosed incident vector',
      );
  }

  private async notifyRun(
    ticketDir: string,
    run: StoredRun,
    phase: 'diagnosis' | 'remediation',
  ) {
    const ticket = JSON.parse(
      await readFile(path.join(ticketDir, 'ticket.json'), 'utf8'),
    ) as StoredTicket;
    if (ticket.updated_at !== run.updated_at)
      return { sent: 0, alreadySent: 0, unmapped: 0 };
    const diagnosis = (
      await readFile(path.join(ticketDir, 'diagnosis.md'), 'utf8')
    ).trim();
    const commentPath = path.join(ticketDir, 'cs-comment.md');
    const comment = (await readFile(commentPath, 'utf8')).trim();
    const engineeringAction = JSON.parse(
      await readFile(path.join(ticketDir, 'engineering-action.json'), 'utf8'),
    ) as EngineeringAction;
    if (
      phase === 'remediation' &&
      !shouldNotifyRemediation(run, engineeringAction)
    ) {
      return { sent: 0, alreadySent: 0, unmapped: 0 };
    }
    const remediation =
      phase === 'remediation'
        ? (JSON.parse(
            await readFile(path.join(ticketDir, 'remediation.json'), 'utf8'),
          ) as RemediationResult)
        : null;
    const spaces = await this.resolveNotificationSpaces(ticket, run, phase);
    if (!spaces.length) {
      this.logger.warn(
        `No Google Chat space mapped for ticket ${ticket.id}; vectors=${(ticket.vectors || []).join(',')}`,
      );
      return { sent: 0, alreadySent: 0, unmapped: 1 };
    }

    let sent = 0;
    let alreadySent = 0;
    for (const space of spaces) {
      const iterationKey =
        phase === 'remediation' && run.remediation_iteration
          ? `:iteration-${run.remediation_iteration}`
          : '';
      const notificationKey = `${ticket.id}:${run.updated_at}:${phase}:${space}${iterationKey}`;
      const notifications =
        await this.state.read<NotificationState>('notifications.json');
      const existing = notifications[notificationKey];
      if (existing?.status === 'sent') {
        alreadySent += 1;
        this.logger.log(
          `Google Chat notification already delivered: ticket=${ticket.id} space=${space}`,
        );
        continue;
      }

      const approvalId = existing?.approvalId || randomUUID();
      const attemptAt = new Date().toISOString();
      if (!existing) {
        if (phase === 'remediation' || ticket.task_type === 'incident') {
          const cardId =
            ticket.task_type === 'incident' && phase === 'diagnosis'
              ? await this.actions.ensureIncidentAssumption(
                  ticket,
                  run,
                  spaces,
                  approvalId,
                )
              : approvalId;
          await this.recordNotificationAttempt(
            notificationKey,
            cardId,
            attemptAt,
          );
          await this.deliverNotification(
            notificationKey,
            cardId,
            ticket,
            run,
            diagnosis,
            comment,
            engineeringAction,
            remediation,
            phase,
            space,
          );
          sent += 1;
          continue;
        }
        const approvals =
          await this.state.read<ApprovalState>('approvals.json');
        const reusable = Object.values(approvals).find(
          (approval) =>
            approval.taskId === ticket.id &&
            approval.taskUpdatedAt === run.updated_at &&
            approval.status === 'pending' &&
            approval.allowedSpaces.includes(space),
        );
        const effectiveApprovalId = reusable?.id || approvalId;
        if (!reusable) {
          const approval: ApprovalRecord = {
            id: effectiveApprovalId,
            taskId: ticket.id,
            taskUpdatedAt: run.updated_at,
            ticketName: ticket.name,
            ticketUrl: ticket.url,
            commentPath,
            commentHash: sha256(comment),
            allowedSpaces: spaces,
            status: 'pending',
            createdAt: new Date().toISOString(),
          };
          await this.state.update<ApprovalState>(
            'approvals.json',
            (current) => {
              current[effectiveApprovalId] = approval;
            },
          );
        }
        await this.recordNotificationAttempt(
          notificationKey,
          effectiveApprovalId,
          attemptAt,
        );
        await this.deliverNotification(
          notificationKey,
          effectiveApprovalId,
          ticket,
          run,
          diagnosis,
          comment,
          engineeringAction,
          remediation,
          phase,
          space,
        );
        sent += 1;
        continue;
      }

      await this.recordNotificationAttempt(
        notificationKey,
        approvalId,
        attemptAt,
      );
      await this.deliverNotification(
        notificationKey,
        approvalId,
        ticket,
        run,
        diagnosis,
        comment,
        engineeringAction,
        remediation,
        phase,
        space,
      );
      sent += 1;
    }
    return { sent, alreadySent, unmapped: 0 };
  }

  private async resolveNotificationSpaces(
    ticket: StoredTicket,
    run: StoredRun,
    phase: 'diagnosis' | 'remediation',
  ) {
    if (
      phase === 'remediation' &&
      run.remediation_iteration &&
      run.remediation_broadcast_to_bound_threads
    ) {
      const threads = await this.state.read<TicketThreadState>(
        'chat-ticket-threads.json',
      );
      const boundSpaces = [
        ...new Set(
          Object.values(threads)
            .filter((thread) => thread.taskId === ticket.id)
            .map((thread) => thread.space),
        ),
      ];
      if (boundSpaces.length) return boundSpaces;
    }
    const directSpace = run.google_chat_space || run.google_chat_user;
    return directSpace
      ? [this.messenger.normalizeSpaceName(directSpace)]
      : this.messenger.resolveSpaces(ticket.vectors || []);
  }

  private async recordNotificationAttempt(
    notificationKey: string,
    approvalId: string,
    attemptAt: string,
  ) {
    const state = await this.state.update<NotificationState>(
      'notifications.json',
      (current) => {
        current[notificationKey] = {
          status: 'pending',
          approvalId,
          attempts: (current[notificationKey]?.attempts || 0) + 1,
          lastAttemptAt: attemptAt,
        };
      },
    );
    return state[notificationKey].attempts;
  }

  private async deliverNotification(
    notificationKey: string,
    approvalId: string,
    ticket: StoredTicket,
    run: StoredRun,
    diagnosis: string,
    comment: string,
    engineeringAction: EngineeringAction,
    remediation: RemediationResult | null,
    phase: 'diagnosis' | 'remediation',
    space: string,
  ) {
    const notifications =
      await this.state.read<NotificationState>('notifications.json');
    this.logger.log(
      `Sending Google Chat notification: ticket=${ticket.id} space=${space} attempt=${notifications[notificationKey]?.attempts || 1}`,
    );
    try {
      const card =
        phase === 'diagnosis'
          ? buildDiagnosisCard(
              ticket,
              run,
              diagnosis,
              comment,
              engineeringAction,
              approvalId,
              this.config.actionUrl,
            )
          : buildRemediationCard(ticket, engineeringAction, remediation!);
      const threads = await this.state.read<TicketThreadState>(
        'chat-ticket-threads.json',
      );
      const preferredThread =
        run.google_chat_thread &&
        run.google_chat_space &&
        this.messenger.normalizeSpaceName(run.google_chat_space) === space
          ? run.google_chat_thread
          : undefined;
      const thread = selectTicketThreadAddress(
        Object.values(threads),
        space,
        ticket.id,
        preferredThread,
      );
      const sent = await this.messenger.sendMessage(
        space,
        card,
        thread,
        notificationRequestId(notificationKey),
      );
      await this.threads.bindTicketThread({
        space,
        taskId: ticket.id,
        ticketName: ticket.name,
        ticketUrl: ticket.url,
        threadName: sent.threadName || thread.threadName,
        approvalId,
        remediationMessageName:
          phase === 'remediation' ? sent.messageName || undefined : undefined,
      });
      await this.state.update<NotificationState>(
        'notifications.json',
        (current) => {
          const record = current[notificationKey];
          if (!record) return;
          record.status = 'sent';
          record.sentAt = new Date().toISOString();
          record.messageName = sent.messageName;
          if (sent.threadName) record.threadName = sent.threadName;
          delete record.lastError;
        },
      );
      this.logger.log(
        `Google Chat notification delivered: ticket=${ticket.id} space=${space} message=${sent.messageName || 'unknown'} thread=${sent.threadName || thread.threadName || thread.threadKey || 'unknown'}`,
      );
    } catch (error) {
      const message = (error as Error).message;
      await this.state.update<NotificationState>(
        'notifications.json',
        (current) => {
          const record = current[notificationKey];
          if (!record) return;
          record.status = 'failed';
          record.lastError = message.slice(0, 1000);
        },
      );
      this.logger.error(
        `Google Chat notification failed: ticket=${ticket.id} space=${space} error=${message}`,
      );
      throw error;
    }
  }
}

export function notificationRequestId(notificationKey: string) {
  const hash = createHash('sha256').update(notificationKey).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function parseOptionalDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`GOOGLE_CHAT_NOTIFY_AFTER is not a valid date: ${value}`);
  return date;
}
