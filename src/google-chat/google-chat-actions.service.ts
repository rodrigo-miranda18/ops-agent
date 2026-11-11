import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ClickUpService } from '../clickup/clickup.service.js';
import { GithubService } from '../github/github.service.js';
import { StateService } from '../state/state.service.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';
import type {
  ApprovalRecord,
  ApprovalState,
  AssumptionNotificationState,
  ChatEvent,
  IncidentAssumptionRecord,
  IncidentAssumptionState,
  IncidentIssueAssignment,
  StoredRun,
  StoredTicket,
  TicketThreadState,
} from './google-chat.types.js';
import { incidentIssues } from './google-chat-cards.js';
import { selectTicketThreadAddress } from './google-chat-threading.js';
import {
  assignmentSummary,
  githubLoginForEmail,
} from './google-chat-github-users.js';
import {
  GOOGLE_CHAT_CONFIG,
  type GoogleChatConfig,
} from '../config/google-chat-config.js';

@Injectable()
export class GoogleChatActionsService {
  private readonly logger = new Logger(GoogleChatActionsService.name);
  private readonly acting = new Set<string>();

  constructor(
    private readonly state: StateService,
    private readonly clickUp: ClickUpService,
    private readonly github: GithubService,
    private readonly messenger: GoogleChatMessengerService,
    @Inject(GOOGLE_CHAT_CONFIG) private readonly config: GoogleChatConfig,
  ) {}

  async handleAction(event: ChatEvent) {
    const invokedFunction =
      event.commonEventObject?.invokedFunction ||
      event.action?.actionMethodName;
    this.logger.log(
      `Google Chat action received: function=${invokedFunction || 'none'} space=${event.space?.name || 'unknown'}`,
    );
    if (
      !['approve_cs_comment', 'assume_ticket', 'assume_incident'].includes(
        invokedFunction || '',
      )
    )
      return { text: 'Ação não reconhecida.' };
    const legacyParameters = Object.fromEntries(
      (event.action?.parameters || []).map(({ key, value }) => [key, value]),
    );
    const approvalId =
      event.commonEventObject?.parameters?.approvalId ||
      legacyParameters.approvalId;
    if (!approvalId)
      return { text: 'Aprovação inválida: identificador ausente.' };
    if (this.acting.has(approvalId))
      return { text: 'Outra ação deste ticket já está sendo processada.' };
    this.acting.add(approvalId);

    try {
      if (invokedFunction === 'assume_incident')
        return await this.performAssumeIncident(approvalId, event);
      if (invokedFunction === 'assume_ticket')
        return await this.performAssume(approvalId, event);
      return await this.performApproval(approvalId, event);
    } finally {
      this.acting.delete(approvalId);
    }
  }

  private async performAssume(approvalId: string, event: ChatEvent) {
    const approvals = await this.state.read<ApprovalState>('approvals.json');
    const approval = approvals[approvalId];
    if (!approval) return { text: 'Este ticket não existe ou expirou.' };
    const space = event.space?.name;
    if (!space || !approval.allowedSpaces.includes(space))
      return { text: 'Você não está autorizado a assumir este ticket.' };
    if (approval.status === 'approved')
      return { text: 'O comentário deste ticket já foi aprovado.' };
    if (approval.assumedBy)
      return { text: `Ticket já assumido por ${approval.assumedBy}.` };

    const email = event.user?.email;
    if (!email)
      return {
        text: 'O Google Chat não informou seu e-mail; não foi possível localizar seu usuário no ClickUp.',
      };
    const assumedBy = event.user?.displayName || email;
    const result = await this.clickUp.assumeTask(approval.taskId, email);
    const updatedAt = toIso(result.task.date_updated);
    await this.state.update<ApprovalState>('approvals.json', (current) => {
      const record = current[approvalId];
      if (!record || record.assumedBy) return;
      record.assumedAt = new Date().toISOString();
      record.assumedBy = assumedBy;
      record.assumedByEmail = email;
      if (updatedAt) record.taskUpdatedAt = updatedAt;
    });
    this.logger.log(
      `ClickUp ticket assumed: task=${approval.taskId} by=${assumedBy} email=${email}`,
    );
    const failed = await this.enqueueAssumptionNotifications(
      approval,
      assumedBy,
    );
    return failed
      ? {
          text: `Ticket assumido por ${assumedBy}. Alguns espaços ainda não receberam o aviso; o envio será tentado novamente.`,
        }
      : {
          text: `Ticket assumido por ${assumedBy}. Todos os espaços que receberam o diagnóstico foram avisados.`,
        };
  }

  async ensureIncidentAssumption(
    ticket: StoredTicket,
    run: StoredRun,
    spaces: string[],
    fallbackId: string,
  ) {
    const assumptions = await this.state.read<IncidentAssumptionState>(
      'incident-assumptions.json',
    );
    const reusable = Object.values(assumptions).find(
      (item) =>
        item.incidentId === ticket.id &&
        item.incidentUpdatedAt === run.updated_at,
    );
    const id = reusable?.id || fallbackId;
    const issues = incidentIssues(ticket).map((issue) => ({
      repository: issue.repository,
      url: issue.url!,
    }));
    await this.state.update<IncidentAssumptionState>(
      'incident-assumptions.json',
      (current) => {
        const record = current[id];
        if (record) {
          record.allowedSpaces = [
            ...new Set([...record.allowedSpaces, ...spaces]),
          ];
          if (!record.assumedBy) record.issues = issues;
          return;
        }
        current[id] = {
          id,
          incidentId: ticket.id,
          incidentUpdatedAt: run.updated_at,
          incidentName: ticket.name,
          allowedSpaces: [...new Set(spaces)],
          issues,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
      },
    );
    return id;
  }

  private async performAssumeIncident(assumptionId: string, event: ChatEvent) {
    const assumptions = await this.state.read<IncidentAssumptionState>(
      'incident-assumptions.json',
    );
    const assumption = assumptions[assumptionId];
    if (!assumption) return { text: 'Este incidente não existe ou expirou.' };
    const space = event.space?.name;
    if (!space || !assumption.allowedSpaces.includes(space))
      return { text: 'Você não está autorizado a assumir este incidente.' };
    if (assumption.assumedBy)
      return { text: `Incidente já assumido por ${assumption.assumedBy}.` };

    const email = event.user?.email;
    if (!email)
      return {
        text: 'O Google Chat não informou seu e-mail; não foi possível registrar quem assumiu o incidente.',
      };
    const assumedBy = event.user?.displayName || email;
    const login = githubLoginForEmail(email, this.config.githubChatUserMapJson);
    await this.state.update<IncidentAssumptionState>(
      'incident-assumptions.json',
      (current) => {
        const record = current[assumptionId];
        if (!record || record.assumedBy) return;
        record.status = 'assumed';
        record.assumedAt = new Date().toISOString();
        record.assumedBy = assumedBy;
        record.assumedByEmail = email;
        if (login) record.assumedByGithub = login;
      },
    );
    this.logger.log(
      `Incident assumed: incident=${assumption.incidentId} by=${assumedBy} email=${email} github=${login || 'unmapped'}`,
    );

    const assignments = login
      ? await this.assignIncidentIssues(assumption, login, assumedBy)
      : [];
    if (assignments.length) {
      await this.state.update<IncidentAssumptionState>(
        'incident-assumptions.json',
        (current) => {
          const record = current[assumptionId];
          if (record) record.githubAssignments = assignments;
        },
      );
    }

    const text = `🙋 **${assumedBy} assumiu o incidente ${assumption.incidentName}.**\n${assignmentSummary(login, assignments)}`;
    const failed = await this.enqueueAssumptionBroadcast(
      assumption.id,
      assumption.incidentId,
      assumption.allowedSpaces,
      text,
    );
    const notice = failed
      ? ' Alguns espaços ainda não receberam o aviso; o envio será tentado novamente.'
      : '';
    return {
      text: `Incidente assumido por ${assumedBy}. ${assignmentSummary(login, assignments)}${notice}`,
    };
  }

  private async assignIncidentIssues(
    assumption: IncidentAssumptionRecord,
    login: string,
    assumedBy: string,
  ) {
    const assignments: IncidentIssueAssignment[] = [];
    for (const issue of assumption.issues) {
      try {
        await this.github.assignIssue(issue.url, login);
        assignments.push({
          repository: issue.repository,
          url: issue.url,
          status: 'assigned',
        });
      } catch (error) {
        const message = (error as Error).message;
        assignments.push({
          repository: issue.repository,
          url: issue.url,
          status: 'failed',
          error: message.slice(0, 1000),
        });
        this.logger.error(
          `GitHub issue assignment failed: issue=${issue.url} login=${login} error=${message}`,
        );
        continue;
      }
      try {
        await this.github.commentIssue(
          issue.url,
          `Incidente assumido por ${assumedBy} (@${login}) pelo Google Chat.`,
        );
      } catch (error) {
        this.logger.error(
          `GitHub issue comment failed: issue=${issue.url} error=${(error as Error).message}`,
        );
      }
    }
    return assignments;
  }

  private async enqueueAssumptionNotifications(
    approval: ApprovalRecord,
    assumedBy: string,
  ) {
    const ticket = approval.ticketName || approval.taskId;
    const text = `🙋 **${assumedBy} assumiu o ticket ${ticket}.**\nA investigação e os próximos passos estão agora sob responsabilidade dessa pessoa.`;
    return this.enqueueAssumptionBroadcast(
      approval.id,
      approval.taskId,
      approval.allowedSpaces,
      text,
    );
  }

  private async enqueueAssumptionBroadcast(
    id: string,
    taskId: string,
    allowedSpaces: string[],
    text: string,
  ) {
    const spaces = [...new Set(allowedSpaces)];
    const threads = await this.state.read<TicketThreadState>(
      'chat-ticket-threads.json',
    );
    await this.state.update<AssumptionNotificationState>(
      'assumption-notifications.json',
      (current) => {
        for (const space of spaces) {
          const key = `${id}:${space}`;
          if (current[key]?.status === 'sent') continue;
          const thread = selectTicketThreadAddress(
            Object.values(threads),
            space,
            taskId,
          );
          current[key] = {
            status: current[key]?.status || 'pending',
            approvalId: id,
            taskId,
            space,
            text,
            attempts: current[key]?.attempts || 0,
            threadName: current[key]?.threadName || thread.threadName,
            threadKey: current[key]?.threadKey || thread.threadKey,
          };
        }
      },
    );
    return this.retryAssumptionNotifications(id);
  }

  async retryAssumptionNotifications(approvalId?: string) {
    const records = await this.state.read<AssumptionNotificationState>(
      'assumption-notifications.json',
    );
    let failed = 0;
    for (const [key, record] of Object.entries(records)) {
      if (
        record.status === 'sent' ||
        (approvalId && record.approvalId !== approvalId)
      )
        continue;
      const attemptAt = new Date().toISOString();
      await this.state.update<AssumptionNotificationState>(
        'assumption-notifications.json',
        (current) => {
          const item = current[key];
          if (!item || item.status === 'sent') return;
          item.status = 'pending';
          item.attempts += 1;
          item.lastAttemptAt = attemptAt;
        },
      );
      try {
        const sent = await this.messenger.sendMessage(
          record.space,
          { text: record.text },
          {
            threadName: record.threadName,
            threadKey: record.threadKey,
          },
        );
        await this.state.update<AssumptionNotificationState>(
          'assumption-notifications.json',
          (current) => {
            const item = current[key];
            if (!item) return;
            item.status = 'sent';
            item.sentAt = new Date().toISOString();
            item.messageName = sent.messageName;
            if (sent.threadName) item.threadName = sent.threadName;
            delete item.lastError;
          },
        );
      } catch (error) {
        failed += 1;
        await this.state.update<AssumptionNotificationState>(
          'assumption-notifications.json',
          (current) => {
            const item = current[key];
            if (!item) return;
            item.status = 'failed';
            item.lastError = (error as Error).message.slice(0, 1000);
          },
        );
        this.logger.error(
          `Ticket assumption notification failed: task=${record.taskId} space=${record.space} error=${(error as Error).message}`,
        );
      }
    }
    return failed;
  }

  private async performApproval(approvalId: string, event: ChatEvent) {
    const approvals = await this.state.read<ApprovalState>('approvals.json');
    const approval = approvals[approvalId];
    if (!approval) return { text: 'Esta aprovação não existe ou expirou.' };
    if (approval.status === 'approved')
      return {
        text: `Comentário já publicado por ${approval.approvedBy || 'outro desenvolvedor'}.`,
      };
    const space = event.space?.name;
    if (!space || !approval.allowedSpaces.includes(space))
      return { text: 'Você não está autorizado a aprovar este comentário.' };

    const task = await this.clickUp.getTask(approval.taskId);
    const currentUpdatedAt = toIso(task.date_updated);
    if (currentUpdatedAt !== approval.taskUpdatedAt) {
      return {
        text: 'O ticket mudou depois do diagnóstico. Execute um novo diagnóstico antes de aprovar.',
      };
    }
    const comment = (await readFile(approval.commentPath, 'utf8')).trim();
    if (sha256(comment) !== approval.commentHash)
      return { text: 'O comentário local mudou. Execute um novo diagnóstico.' };

    let commentId = approval.clickupCommentId || null;
    if (!commentId) {
      const marker = clickUpCommentMarker(approvalId, approval.commentHash);
      commentId = await this.clickUp.findCommentByMarker(
        approval.taskId,
        marker,
      );
      if (!commentId) {
        const result = await this.clickUp.addComment(
          approval.taskId,
          `${comment}\n\n${marker}`,
        );
        commentId = result.id ? String(result.id) : null;
      }
      await this.state.update<ApprovalState>('approvals.json', (current) => {
        const record = current[approvalId];
        if (record && record.status !== 'approved')
          record.clickupCommentId = commentId;
      });
    }
    await this.clickUp.moveToInDevelopment(approval.taskId);
    const approvedBy =
      event.user?.displayName ||
      event.user?.email ||
      event.user?.name ||
      'desenvolvedor';
    await this.state.update<ApprovalState>('approvals.json', (current) => {
      const record = current[approvalId];
      if (!record || record.status === 'approved') return;
      record.status = 'approved';
      record.approvedAt = new Date().toISOString();
      record.approvedBy = approvedBy;
      record.clickupCommentId = commentId;
    });
    this.logger.log(
      `ClickUp comment approved and published: task=${approval.taskId} approval=${approvalId} by=${approvedBy}`,
    );
    return { text: `Comentário publicado no ClickUp por ${approvedBy}.` };
  }
}

export function clickUpCommentMarker(approvalId: string, commentHash: string) {
  return `<!-- driva-ops-approval:${approvalId}:${commentHash} -->`;
}

export function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function toIso(timestamp: unknown) {
  if (!timestamp) return null;
  const date = new Date(
    Number.isNaN(Number(timestamp)) ? String(timestamp) : Number(timestamp),
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
