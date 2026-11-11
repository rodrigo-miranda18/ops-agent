import { Inject, Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { DiagnosisExecutionService } from '../diagnosis/diagnosis-execution.service.js';
import { ticketResultsDir } from '../diagnosis/diagnosis-artifacts.js';
import { GithubService } from '../github/github.service.js';
import { GoogleChatMessengerService } from '../google-chat/google-chat-messenger.service.js';
import { notificationRequestId } from '../google-chat/google-chat-notifications.service.js';
import type { TicketThreadState } from '../google-chat/google-chat.types.js';
import { StateService } from '../state/state.service.js';
import {
  incidentRecurrenceCommentBody,
  type IncidentIssue,
  type IncidentRemediation,
} from './incident-issues.js';
import { isOpenGitHubState, recurrenceMessage } from './incident-recurrence.js';
import type { IncidentRecord } from './incidents.service.js';

export interface RecurrenceSuppression {
  openUrls: string[];
  openIssueUrls: string[];
}

@Injectable()
export class IncidentRecurrenceService {
  private readonly logger = new Logger(IncidentRecurrenceService.name);

  constructor(
    private readonly state: StateService,
    private readonly executions: DiagnosisExecutionService,
    private readonly github: GithubService,
    private readonly messenger: GoogleChatMessengerService,
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
  ) {}

  async suppressionFor(
    anchor: IncidentRecord,
  ): Promise<RecurrenceSuppression | null> {
    try {
      if (await this.executions.findActiveByTicket(anchor.incidentId))
        return { openUrls: [], openIssueUrls: [] };
      const urls = await this.trackedGitHubUrls(anchor.incidentId);
      const openUrls: string[] = [];
      const openIssueUrls: string[] = [];
      for (const url of urls) {
        const isPullRequest = url.includes('/pull/');
        const status = isPullRequest
          ? await this.github.viewPullRequest(url)
          : await this.github.viewIssue(url);
        if (!isOpenGitHubState(status.state)) continue;
        openUrls.push(url);
        if (!isPullRequest) openIssueUrls.push(url);
      }
      return openUrls.length ? { openUrls, openIssueUrls } : null;
    } catch (error) {
      this.logger.warn(
        `Could not check recurrence of ${anchor.incidentId}; diagnosing again: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async announce(
    input: {
      incident: IncidentRecord;
      anchor: IncidentRecord;
      count: number;
    } & RecurrenceSuppression,
  ): Promise<void> {
    await this.commentIssues(input);
    await this.notifyChat(input);
  }

  private async commentIssues(
    input: { incident: IncidentRecord; anchor: IncidentRecord } & Pick<
      RecurrenceSuppression,
      'openIssueUrls'
    >,
  ) {
    if (!input.openIssueUrls.length) return;
    const ticket = await readOptionalJson<{ vectors?: string[] }>(
      path.join(
        ticketResultsDir(this.runtime.resultsDir, input.anchor.incidentId),
        'ticket.json',
      ),
    ).catch(() => null);
    const body = incidentRecurrenceCommentBody({
      incidentId: input.incident.incidentId,
      startedAt: input.incident.startedAt,
      severity: input.incident.severity,
      vector: ticket?.vectors?.join(', '),
    });
    for (const url of input.openIssueUrls) {
      try {
        await this.github.commentIssue(url, body);
      } catch (error) {
        this.logger.warn(
          `Could not comment incident recurrence on ${url}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async notifyChat(input: {
    incident: IncidentRecord;
    anchor: IncidentRecord;
    count: number;
    openUrls: string[];
  }) {
    const threads = await this.state.read<TicketThreadState>(
      'chat-ticket-threads.json',
    );
    const bound = Object.values(threads).filter(
      (thread) =>
        thread.taskId === input.anchor.incidentId && thread.threadName,
    );
    if (!bound.length) {
      this.logger.log(
        `No Google Chat thread bound to ${input.anchor.incidentId}; recurrence ${input.incident.incidentId} not announced`,
      );
      return;
    }
    const text = recurrenceMessage(input);
    for (const thread of bound) {
      try {
        await this.messenger.sendMessage(
          thread.space,
          { text },
          { threadName: thread.threadName },
          notificationRequestId(
            `${input.incident.incidentId}:recurrence:${thread.space}`,
          ),
        );
      } catch (error) {
        this.logger.error(
          `Recurrence notification failed: incident=${input.incident.incidentId} space=${thread.space} error=${(error as Error).message}`,
        );
      }
    }
  }

  private async trackedGitHubUrls(incidentId: string): Promise<string[]> {
    const ticketDir = ticketResultsDir(this.runtime.resultsDir, incidentId);
    const issues =
      (await readOptionalJson<IncidentIssue[]>(
        path.join(ticketDir, 'github-issues.json'),
      )) || [];
    const remediation = await readOptionalJson<IncidentRemediation>(
      path.join(ticketDir, 'remediation.json'),
    );
    return [
      ...new Set(
        [...issues, ...(remediation?.pull_requests || [])].flatMap((item) =>
          item.url ? [item.url] : [],
        ),
      ),
    ];
  }
}

async function readOptionalJson<T>(filename: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filename, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
