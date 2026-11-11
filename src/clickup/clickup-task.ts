import { includesClickUpArea } from '../config/area-values.js';
import type {
  AttachmentMetadata,
  ClickUpAttachment,
  ClickUpCustomField,
  ClickUpFieldOption,
  ClickUpTask,
  TicketComment,
  TicketFields,
} from './clickup.types.js';

export interface TicketFilterConfig {
  taskType: string;
  taskTypeId: string;
  ticketTypeFieldId: string;
  ticketTypeField: string;
  ticketTypeValue: string;
  areaFieldId: string;
  areaField: string;
  areaValues: readonly string[];
  vectorsFieldId: string;
  vectorsField: string;
  tags: readonly string[];
  createdWithinMinutes: number;
}

export function richTextToPlain(plain: unknown, fragments: unknown): string {
  if (typeof plain === 'string') return plain;
  if (!Array.isArray(fragments)) return '';
  return (fragments as Array<{ text?: string }>)
    .map((fragment) => fragment.text || '')
    .join('');
}

export function normalize(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

function optionName(field: ClickUpCustomField | undefined): unknown {
  const value = field?.value;
  if (value === null || value === undefined) return null;
  const options: ClickUpFieldOption[] = field?.type_config?.options || [];
  if (Array.isArray(value)) {
    return value
      .map((id: unknown) => {
        const option = options.find((item) => item.id === id);
        return option?.name || option?.label || id;
      })
      .join(', ');
  }
  const option = options.find(
    (item) => item.id === value || String(item.orderindex) === String(value),
  );
  return option?.name || option?.label || value;
}

export function customFieldValue(
  task: ClickUpTask,
  fieldId: string,
  fieldName: string,
): unknown {
  const fields = task.custom_fields || [];
  const field =
    (fieldId && fields.find((item) => item.id === fieldId)) ||
    fields.find(
      (item) =>
        normalize(item.name) === normalize(fieldName) &&
        item.value !== null &&
        item.value !== undefined,
    );
  return field ? optionName(field) : null;
}

export function customFieldValues(
  task: ClickUpTask,
  fieldId: string,
  fieldName: string,
): string[] {
  const value = customFieldValue(task, fieldId, fieldName);
  if (value === null || value === undefined || value === '') return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function nameOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? (value as { name?: unknown }).name
    : undefined;
}

export function taskTypeName(task: ClickUpTask): string | null {
  const candidates = [
    nameOf(task.task_type),
    task.task_type,
    nameOf(task.type),
    task.type,
    nameOf(task.custom_item),
  ];
  const name = candidates.find(
    (value): value is string => typeof value === 'string' && !!value.trim(),
  );
  return name || null;
}

function statusObject(task: ClickUpTask) {
  return typeof task.status === 'object' && task.status !== null
    ? task.status
    : undefined;
}

export function isClosed(task: ClickUpTask): boolean {
  const status = statusObject(task);
  return (
    normalize(status?.type) === 'closed' ||
    normalize(status?.status || task.status) === 'closed'
  );
}

function clickUpDate(value: unknown): Date {
  return new Date(
    Number.isNaN(Number(value)) ? (value as string) : Number(value),
  );
}

export function wasCreatedWithin(
  task: ClickUpTask,
  minutes: number,
  now = Date.now(),
): boolean {
  const createdAt = clickUpDate(task.date_created);
  if (Number.isNaN(createdAt.getTime())) return false;
  const ageMs = now - createdAt.getTime();
  return ageMs >= 0 && ageMs <= minutes * 60_000;
}

export function ticketFields(
  task: ClickUpTask,
  config: TicketFilterConfig,
): TicketFields {
  return {
    taskType: taskTypeName(task),
    taskTypeId:
      task.custom_item_id === null || task.custom_item_id === undefined
        ? null
        : String(task.custom_item_id),
    ticketType: customFieldValue(
      task,
      config.ticketTypeFieldId,
      config.ticketTypeField,
    ),
    area: customFieldValue(task, config.areaFieldId, config.areaField),
    vectors: customFieldValues(
      task,
      config.vectorsFieldId,
      config.vectorsField,
    ),
  };
}

export function matchesTicket(
  task: ClickUpTask,
  config: TicketFilterConfig,
): { matches: boolean; actual: TicketFields } {
  const actual = ticketFields(task, config);
  const requiredTags = config.tags.map(normalize);
  const actualTags = (task.tags || []).map((tag) => normalize(tag.name));
  const matchesTaskType = config.taskTypeId
    ? actual.taskTypeId === String(config.taskTypeId)
    : normalize(actual.taskType) === normalize(config.taskType);
  const matches =
    !isClosed(task) &&
    wasCreatedWithin(task, config.createdWithinMinutes) &&
    matchesTaskType &&
    normalize(actual.ticketType) === normalize(config.ticketTypeValue) &&
    includesClickUpArea(config.areaValues, actual.area) &&
    requiredTags.every((tag) => actualTags.includes(tag));
  return { matches, actual };
}

export function toIso(timestamp: unknown): string | null {
  if (!timestamp) return null;
  const date = clickUpDate(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function reference(value: ClickUpTask['list']) {
  return value ? { id: value.id, name: value.name } : null;
}

export function normalizeTicket(
  task: ClickUpTask,
  comments: TicketComment[],
  matchedFields: Partial<TicketFields>,
  attachments: AttachmentMetadata[] = [],
) {
  return {
    id: String(task.id),
    custom_id: task.custom_id || null,
    name: task.name || '',
    description: task.markdown_description || task.description || '',
    url: task.url || null,
    status: statusObject(task)?.status || task.status || null,
    task_type: matchedFields.taskType,
    ticket_type: matchedFields.ticketType,
    area: matchedFields.area,
    vectors: matchedFields.vectors || [],
    created_at: toIso(task.date_created),
    updated_at: toIso(task.date_updated) || String(task.date_updated || ''),
    priority: task.priority?.priority || null,
    tags: (task.tags || []).map((tag) => tag.name),
    assignees: (task.assignees || []).map((user) => ({
      id: user.id,
      username: user.username || null,
    })),
    list: reference(task.list),
    folder: reference(task.folder),
    space: reference(task.space),
    comments,
    attachments,
  };
}

const UNSAFE_FILENAME_CHARS = '\\/:*?"<>|';

function replaceUnsafeFilenameChars(value: string): string {
  return Array.from(value, (char) =>
    char.charCodeAt(0) < 0x20 || UNSAFE_FILENAME_CHARS.includes(char)
      ? '_'
      : char,
  ).join('');
}

export function safeFilename(value: unknown, fallback: string): string {
  const cleaned = replaceUnsafeFilenameChars(String(value || fallback))
    .replace(/^\.+/, '')
    .slice(0, 180);
  return cleaned || fallback;
}

export function isImageAttachment(
  attachment: ClickUpAttachment,
  filename: string,
): boolean {
  return (
    String(attachment.mimetype || '').startsWith('image/') ||
    /\.(png|jpe?g|gif|webp)$/i.test(filename)
  );
}

const CLICKUP_ATTACHMENT_HOST = 'clickup-attachments.com';

export function isClickUpAttachmentUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (host === CLICKUP_ATTACHMENT_HOST ||
      host.endsWith(`.${CLICKUP_ATTACHMENT_HOST}`))
  );
}
