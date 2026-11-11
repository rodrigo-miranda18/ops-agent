import { Inject, Injectable } from '@nestjs/common';
import {
  CLICKUP_CONFIG,
  type ClickUpConfig,
} from '../config/clickup-config.js';
import { clickupRequest, serviceClickUpError } from './clickup-api.js';

@Injectable()
export class ClickUpService {
  constructor(@Inject(CLICKUP_CONFIG) private readonly config: ClickUpConfig) {}

  private get token() {
    const { token } = this.config;
    if (!token) throw new Error('CLICKUP_API_TOKEN is required');
    return token;
  }

  async getTask(
    taskId: string,
    teamId?: string,
  ): Promise<Record<string, unknown>> {
    const query = teamId
      ? `?custom_task_ids=true&team_id=${encodeURIComponent(teamId)}`
      : '';
    return this.request(`/task/${encodeURIComponent(taskId)}${query}`);
  }

  async findCommentByMarker(
    taskId: string,
    marker: string,
  ): Promise<string | null> {
    const data = await this.request(
      `/task/${encodeURIComponent(taskId)}/comment`,
    );
    const comments = Array.isArray(data.comments) ? data.comments : [];
    const existing = comments.find((comment) =>
      JSON.stringify(comment).includes(marker),
    ) as { id?: unknown } | undefined;
    return existing?.id ? String(existing.id) : null;
  }

  async addComment(
    taskId: string,
    commentText: string,
  ): Promise<Record<string, unknown>> {
    return this.request(`/task/${encodeURIComponent(taskId)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ comment_text: commentText, notify_all: false }),
    });
  }

  async moveToInDevelopment(taskId: string): Promise<Record<string, unknown>> {
    return this.updateTask(taskId, {
      status: this.config.inDevelopmentStatus,
    });
  }

  async assumeTask(
    taskId: string,
    email: string,
  ): Promise<{ memberId: number; task: Record<string, unknown> }> {
    const member = await this.findMemberByEmail(email);
    if (!member)
      throw new Error(`Nenhum membro do ClickUp foi encontrado para ${email}`);

    const task = await this.getTask(taskId);
    const currentAssignees = Array.isArray(task.assignees)
      ? task.assignees
          .map((assignee) => Number((assignee as { id?: unknown }).id))
          .filter(Number.isFinite)
      : [];
    const memberId = Number(member.id);
    await this.updateTask(taskId, {
      status: this.config.inDevelopmentStatus,
      assignees: {
        add: currentAssignees.includes(memberId) ? [] : [memberId],
        rem: currentAssignees.filter((id) => id !== memberId),
      },
    });
    return { memberId, task: await this.getTask(taskId) };
  }

  private async findMemberByEmail(
    email: string,
  ): Promise<Record<string, unknown> | null> {
    const data = await this.request('/team');
    const teams = Array.isArray(data.teams) ? data.teams : [];
    for (const team of teams) {
      const members = Array.isArray((team as { members?: unknown }).members)
        ? (team as { members: Array<{ user?: Record<string, unknown> }> })
            .members
        : [];
      for (const member of members) {
        if (
          String(member.user?.email || '').toLocaleLowerCase('pt-BR') ===
          email.toLocaleLowerCase('pt-BR')
        ) {
          return member.user || null;
        }
      }
    }
    return null;
  }

  private async updateTask(
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(`/task/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  private request(endpoint: string, init: RequestInit = {}) {
    return clickupRequest(
      { token: this.token, formatError: serviceClickUpError },
      endpoint,
      init,
    );
  }
}
