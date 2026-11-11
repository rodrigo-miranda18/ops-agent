import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitize } from '../common/sanitize.js';
import {
  resolveVectorFieldUpdate,
  vectorsEqual,
  type DiagnosisVector,
} from '../diagnosis/vector-classification.js';
import {
  customFieldValues,
  isClickUpAttachmentUrl,
  isImageAttachment,
  richTextToPlain,
  safeFilename,
  toIso,
} from './clickup-task.js';
import type {
  AttachmentMetadata,
  ClickUpAttachment,
  ClickUpComment,
  ClickUpTask,
  TicketComment,
} from './clickup.types.js';

const CLICKUP_API_URL = 'https://api.clickup.com/api/v2';
const CLICKUP_REQUEST_TIMEOUT_MS = 30_000;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000;
const TASKS_PAGE_SIZE = 100;
const MAX_TASK_PAGE = 99;

export type ClickUpErrorFormatter = (status: number, body: string) => string;

export const runnerClickUpError: ClickUpErrorFormatter = (status, body) =>
  `ClickUp API ${status}: ${sanitize(body).slice(0, 500)}`;

export const serviceClickUpError: ClickUpErrorFormatter = (status, body) =>
  `ClickUp API ${status}: ${body.slice(0, 500)}`;

export interface ClickUpRequestOptions {
  token: string;
  formatError?: ClickUpErrorFormatter;
}

export async function clickupRequest<T = Record<string, unknown>>(
  options: ClickUpRequestOptions,
  endpoint: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${CLICKUP_API_URL}${endpoint}`, {
    ...init,
    headers: {
      Authorization: options.token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(CLICKUP_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text();
    const formatError = options.formatError || runnerClickUpError;
    throw new Error(formatError(response.status, body));
  }
  return response.json() as Promise<T>;
}

export interface RunnerClickUpConfig {
  token: string;
  listId: string;
  includeSubtasks: boolean;
  createdWithinMinutes: number;
  statuses: readonly string[];
  vectorsFieldId: string;
  vectorsField: string;
  diagnosisVectors: readonly DiagnosisVector[];
  maxAttachments: number;
  maxAttachmentBytes: number;
}

export function fetchTask(
  config: Pick<RunnerClickUpConfig, 'token'>,
  taskId: string,
  query = '',
): Promise<ClickUpTask> {
  return clickupRequest<ClickUpTask>(
    config,
    `/task/${encodeURIComponent(taskId)}${query ? `?${query}` : ''}`,
  );
}

export async function fetchRichComments(
  config: Pick<RunnerClickUpConfig, 'token'>,
  taskId: string,
): Promise<unknown[]> {
  const data = await clickupRequest<{ comments?: unknown }>(
    config,
    `/task/${encodeURIComponent(taskId)}/comment`,
  );
  return Array.isArray(data.comments) ? data.comments : [];
}

export async function fetchCommentReplies(
  config: Pick<RunnerClickUpConfig, 'token'>,
  commentId: string,
): Promise<unknown[]> {
  const data = await clickupRequest<{ comments?: unknown }>(
    config,
    `/comment/${encodeURIComponent(commentId)}/reply`,
  );
  return Array.isArray(data.comments) ? data.comments : [];
}

export async function fetchWorkspaceMembers(
  config: Pick<RunnerClickUpConfig, 'token'>,
  teamId: string,
): Promise<unknown[]> {
  const data = await clickupRequest<{ team?: { members?: unknown } }>(
    config,
    `/team/${encodeURIComponent(teamId)}`,
  );
  return Array.isArray(data.team?.members) ? data.team.members : [];
}

export interface VectorSynchronization {
  updated: boolean;
  previousVectors: string[];
}

export async function synchronizeDiagnosedVector(
  config: Pick<
    RunnerClickUpConfig,
    'token' | 'vectorsFieldId' | 'vectorsField' | 'diagnosisVectors'
  >,
  taskId: string,
  diagnosedVector: string,
): Promise<VectorSynchronization> {
  const task = await fetchTask(config, taskId);
  const previousVectors = customFieldValues(
    task,
    config.vectorsFieldId,
    config.vectorsField,
  );
  if (vectorsEqual(previousVectors, [diagnosedVector])) {
    return { updated: false, previousVectors };
  }
  const update = resolveVectorFieldUpdate(
    task,
    config.vectorsFieldId,
    config.vectorsField,
    diagnosedVector,
    config.diagnosisVectors,
  );
  await clickupRequest(
    config,
    `/task/${encodeURIComponent(taskId)}/field/${encodeURIComponent(update.fieldId)}`,
    { method: 'POST', body: JSON.stringify({ value: update.value }) },
  );
  return { updated: true, previousVectors };
}

export async function fetchTasks(
  config: Pick<
    RunnerClickUpConfig,
    'token' | 'listId' | 'includeSubtasks' | 'createdWithinMinutes' | 'statuses'
  >,
): Promise<ClickUpTask[]> {
  const tasks: ClickUpTask[] = [];
  for (let page = 0; ; page += 1) {
    const query = new URLSearchParams({
      archived: 'false',
      include_closed: 'false',
      subtasks: String(config.includeSubtasks),
      page: String(page),
      date_created_gt: String(
        Date.now() - config.createdWithinMinutes * 60_000,
      ),
    });
    for (const status of config.statuses) query.append('statuses[]', status);
    const data = await clickupRequest<{ tasks?: unknown }>(
      config,
      `/list/${encodeURIComponent(config.listId)}/task?${query.toString()}`,
    );
    const pageTasks = Array.isArray(data.tasks)
      ? (data.tasks as ClickUpTask[])
      : [];
    tasks.push(...pageTasks);
    if (pageTasks.length < TASKS_PAGE_SIZE || page >= MAX_TASK_PAGE) break;
  }
  return tasks;
}

export async function fetchComments(
  config: Pick<RunnerClickUpConfig, 'token'>,
  taskId: string,
): Promise<TicketComment[]> {
  const data = await clickupRequest<{ comments?: ClickUpComment[] }>(
    config,
    `/task/${encodeURIComponent(taskId)}/comment`,
  );
  return (data.comments || []).map((comment) => ({
    id: String(comment.id),
    author: comment.user?.username || comment.user?.email || null,
    text: richTextToPlain(comment.comment_text, comment.comment),
    created_at: toIso(comment.date),
    resolved: comment.resolved ?? null,
  }));
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MAX_ATTACHMENT_REDIRECTS = 3;

async function writeLimitedResponse(
  response: Response,
  maxBytes: number,
  localPath: string,
): Promise<void> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const tooLarge = `file exceeds ${megabytes(maxBytes)} MB limit`;
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error(tooLarge);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error(tooLarge);
  await writeFile(localPath, data, { mode: 0o600 });
}

export async function downloadClickUpFile(
  config: Pick<RunnerClickUpConfig, 'token' | 'maxAttachmentBytes'>,
  sourceUrl: string,
  localPath: string,
): Promise<void> {
  const response = await fetch(sourceUrl, {
    headers: { 'x-api-key': config.token },
    redirect: 'follow',
    signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
  });
  await writeLimitedResponse(response, config.maxAttachmentBytes, localPath);
}

export async function downloadClickUpAttachment(
  config: Pick<RunnerClickUpConfig, 'token' | 'maxAttachmentBytes'>,
  sourceUrl: string,
  localPath: string,
): Promise<void> {
  let url = sourceUrl;
  for (let redirects = 0; ; redirects += 1) {
    if (!isClickUpAttachmentUrl(url))
      throw new Error('Attachment URL is not a ClickUp attachment host');
    const response = await fetch(url, {
      headers: { 'x-api-key': config.token },
      redirect: 'manual',
      signal: AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (redirects >= MAX_ATTACHMENT_REDIRECTS)
        throw new Error('Too many attachment redirects');
      url = new URL(location, url).toString();
      continue;
    }
    await writeLimitedResponse(response, config.maxAttachmentBytes, localPath);
    return;
  }
}

export async function downloadAttachments(
  config: Pick<
    RunnerClickUpConfig,
    'token' | 'maxAttachments' | 'maxAttachmentBytes'
  >,
  task: ClickUpTask,
  ticketDir: string,
): Promise<AttachmentMetadata[]> {
  const sourceAttachments: ClickUpAttachment[] = Array.isArray(task.attachments)
    ? (task.attachments as ClickUpAttachment[]).slice(0, config.maxAttachments)
    : [];
  if (!sourceAttachments.length) return [];

  const attachmentDir = path.join(ticketDir, 'attachments');
  await mkdir(attachmentDir, { recursive: true });
  const downloaded: AttachmentMetadata[] = [];

  for (const [index, attachment] of sourceAttachments.entries()) {
    const filename = safeFilename(
      attachment.title || attachment.name,
      `attachment-${index + 1}`,
    );
    const localPath = path.join(attachmentDir, `${index + 1}-${filename}`);
    const sourceUrl =
      attachment.url || attachment.url_w_query || attachment.external_url;
    const metadata: AttachmentMetadata = {
      id: String(attachment.id || index + 1),
      filename,
      mimetype: attachment.mimetype || null,
      size: attachment.size === undefined ? null : Number(attachment.size),
      local_path: null,
      image_context: false,
      status: 'skipped',
      error: null,
    };

    if (!sourceUrl) {
      metadata.error = 'Attachment has no downloadable URL';
      downloaded.push(metadata);
      continue;
    }
    if (metadata.size && metadata.size > config.maxAttachmentBytes) {
      metadata.error = `Attachment exceeds ${megabytes(config.maxAttachmentBytes)} MB limit`;
      downloaded.push(metadata);
      continue;
    }

    try {
      await downloadClickUpFile(config, sourceUrl, localPath);
      metadata.local_path = localPath;
      metadata.image_context = isImageAttachment(attachment, filename);
      metadata.status = 'downloaded';
    } catch (error) {
      metadata.status = 'error';
      metadata.error = sanitize(errorMessage(error));
    }
    downloaded.push(metadata);
  }
  return downloaded;
}
