import {
  fetchCommentReplies,
  fetchRichComments,
  fetchTask,
  fetchWorkspaceMembers,
} from '../clickup/clickup-api.js';
import { isClickUpAttachmentUrl } from '../clickup/clickup-task.js';
import { communicationSize } from './communication-size.js';
import type { ClickUpContext } from './communication.types.js';
import { findImprovementTickets } from './improvement-tickets.js';
export { findImprovementTickets } from './improvement-tickets.js';

const INLINE_IMAGE_PATTERN = /!\[[^\]]*\]\((https:\/\/[^\s)]+)\)/g;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function idOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function customIdOf(record: UnknownRecord): string | null {
  return asString(record.custom_id) || null;
}

export function richCommentText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) continue;
    const text = asString(record.text);
    if (text) parts.push(text);
    const link = asString(asRecord(record.attributes)?.link);
    if (link && !text.includes(link)) parts.push(` ${link} `);
    const bookmark = asRecord(record.bookmark);
    const bookmarkUrl = asString(bookmark?.url);
    if (bookmarkUrl) parts.push(` ${bookmarkUrl} `);
    const url = asString(record.url);
    if (url) parts.push(` ${url} `);
  }
  return parts.join('').trim();
}

export function collectImageUrls(
  markdown: readonly string[],
  attachments: unknown[],
  maxImages = Number.POSITIVE_INFINITY,
): string[] {
  const urls = new Set<string>();
  for (const text of markdown) {
    for (const match of text.matchAll(INLINE_IMAGE_PATTERN)) {
      if (match[1] && isClickUpAttachmentUrl(match[1])) urls.add(match[1]);
    }
  }
  for (const item of attachments) {
    const attachment = asRecord(item);
    if (!attachment || !asString(attachment.mimetype).startsWith('image/')) {
      continue;
    }
    const url = asString(attachment.url) || asString(attachment.url_w_query);
    if (url && isClickUpAttachmentUrl(url)) urls.add(url);
  }
  return [...urls].slice(0, maxImages);
}

export interface ClickUpContextConfig {
  token: string;
  teamId: string;
  maxImages: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectComments(
  config: ClickUpContextConfig,
  taskId: string,
  warnings: string[],
): Promise<ClickUpContext['comments']> {
  const result: ClickUpContext['comments'] = [];
  const push = (raw: unknown) => {
    const comment = asRecord(raw);
    if (!comment) return null;
    const user = asRecord(comment.user);
    const text =
      richCommentText(comment.comment) || asString(comment.comment_text);
    const timestamp = Number(comment.date);
    result.push({
      taskId,
      author: asString(user?.username) || asString(user?.email) || 'unknown',
      date: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '',
      text,
    });
    return comment;
  };
  let comments: unknown[];
  try {
    comments = await fetchRichComments(config, taskId);
  } catch (error) {
    warnings.push(
      `Comentários da task ${taskId} indisponíveis: ${errorMessage(error)}`,
    );
    return result;
  }
  for (const raw of comments) {
    const comment = push(raw);
    if (!comment || !(Number(comment.reply_count) > 0)) continue;
    try {
      for (const reply of await fetchCommentReplies(config, idOf(comment.id))) {
        push(reply);
      }
    } catch (error) {
      warnings.push(
        `Respostas do comentário ${idOf(comment.id)} indisponíveis: ${errorMessage(error)}`,
      );
    }
  }
  return result;
}

async function hydrateSubtask(
  config: ClickUpContextConfig,
  subtask: UnknownRecord,
  warnings: string[],
): Promise<UnknownRecord> {
  try {
    const full = asRecord(
      await fetchTask(
        config,
        idOf(subtask.id),
        'include_markdown_description=true',
      ),
    );
    return full ?? subtask;
  } catch (error) {
    warnings.push(
      `Subtask ${idOf(subtask.id)} indisponível: ${errorMessage(error)}`,
    );
    return subtask;
  }
}

function descriptionOf(record: UnknownRecord): string {
  return (
    asString(record.markdown_description) ||
    asString(record.text_content) ||
    asString(record.description)
  );
}

export async function collectClickUpContext(
  config: ClickUpContextConfig,
  taskId: string,
): Promise<ClickUpContext> {
  const warnings: string[] = [];
  const fetched = await fetchTask(
    config,
    taskId,
    'include_subtasks=true&include_markdown_description=true',
  );
  const main = asRecord(fetched);
  if (!main) throw new Error(`ClickUp task ${taskId} returned no data`);

  const rawSubtasks = (Array.isArray(main.subtasks) ? main.subtasks : [])
    .map(asRecord)
    .filter((item): item is UnknownRecord => item !== null);
  const subtasks: UnknownRecord[] = [];
  for (const subtask of rawSubtasks) {
    subtasks.push(await hydrateSubtask(config, subtask, warnings));
  }

  const comments: ClickUpContext['comments'] = [];
  for (const id of [
    idOf(main.id) || taskId,
    ...subtasks.map((s) => idOf(s.id)),
  ]) {
    comments.push(...(await collectComments(config, id, warnings)));
  }

  let members: unknown[] = [];
  try {
    members = await fetchWorkspaceMembers(config, config.teamId);
  } catch (error) {
    warnings.push(`Membros do workspace indisponíveis: ${errorMessage(error)}`);
  }

  const improvementTickets = findImprovementTickets(
    [main, ...subtasks],
    members,
  );
  for (const ticket of improvementTickets) {
    const label = ticket.customId || ticket.id;
    if (!ticket.owners.length)
      warnings.push(
        `Ticket de melhoria ${label}: campo Dono ausente ou inválido; ninguém será marcado.`,
      );
    for (const owner of ticket.owners) {
      if (!owner.email)
        warnings.push(
          `Ticket de melhoria ${label}: ${owner.username} sem e-mail; será citado apenas pelo nome.`,
        );
    }
  }

  const descriptions = [main, ...subtasks].map(descriptionOf);
  const attachments = [main, ...subtasks].flatMap((record) =>
    Array.isArray(record.attachments) ? record.attachments : [],
  );

  return {
    task: {
      id: idOf(main.id) || taskId,
      customId: customIdOf(main),
      name: asString(main.name),
      url: asString(main.url),
      description: descriptionOf(main),
      communicationSize: communicationSize(fetched),
    },
    subtasks: subtasks.map((subtask) => ({
      id: idOf(subtask.id),
      customId: customIdOf(subtask),
      name: asString(subtask.name),
      description: descriptionOf(subtask),
      taskType: asString(subtask.task_type) || null,
    })),
    comments,
    improvementTickets,
    imageUrls: collectImageUrls(
      [...descriptions, ...comments.map((comment) => comment.text)],
      attachments,
      config.maxImages,
    ),
    warnings,
  };
}
