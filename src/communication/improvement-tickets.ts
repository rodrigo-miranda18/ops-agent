import { normalize, taskTypeName } from '../clickup/clickup-task.js';
import type { ImprovementTicket, TicketOwner } from './communication.types.js';

const FORM_RESPONSE_TYPE_ID = '3';
const OWNER_FIELD_ID = '00000000-0000-0000-0000-000000000005';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function id(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function fieldsOf(task: UnknownRecord): UnknownRecord[] {
  return Array.isArray(task.custom_fields)
    ? task.custom_fields.flatMap((field) => {
        const item = record(field);
        return item ? [item] : [];
      })
    : [];
}

function isImprovement(task: UnknownRecord): boolean {
  const type = taskTypeName({
    id: id(task.id),
    task_type: task.task_type,
    type: task.type,
    custom_item: task.custom_item,
  });
  if (
    id(task.custom_item_id) !== FORM_RESPONSE_TYPE_ID &&
    normalize(type) !== 'form_response'
  )
    return false;
  return fieldsOf(task).some((field) => {
    if (normalize(field.name) !== 'tipo do ticket') return false;
    const options = record(field.type_config)?.options;
    if (
      !Array.isArray(options) ||
      field.value === undefined ||
      field.value === null
    )
      return false;
    return options.some((option) => {
      const item = record(option);
      return (
        item !== null &&
        (id(item.id) === id(field.value) ||
          (item.orderindex !== undefined &&
            id(item.orderindex) === id(field.value))) &&
        normalize(item.name || item.label) === 'melhoria de produto'
      );
    });
  });
}

function ownersOf(
  task: UnknownRecord,
  members: Map<string, UnknownRecord>,
): TicketOwner[] {
  const fields = fieldsOf(task);
  const field =
    fields.find((item) => item.id === OWNER_FIELD_ID) ||
    fields.find((item) => normalize(item.name) === 'dono');
  if (field?.type !== 'users' || !Array.isArray(field.value)) return [];
  const seen = new Set<string>();
  return field.value.flatMap((value) => {
    const owner = record(value);
    if (!owner) return [];
    const member = members.get(id(owner.id));
    const email =
      (text(owner.email) || text(member?.email)).toLowerCase() || null;
    const username = text(owner.username) || text(member?.username) || email;
    if (!username) return [];
    const key = id(owner.id) || email || username;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ username, email }];
  });
}

export function findImprovementTickets(
  tasks: unknown[],
  members: unknown[],
): ImprovementTicket[] {
  const users = new Map<string, UnknownRecord>();
  for (const member of members) {
    const user = record(record(member)?.user);
    if (user && id(user.id)) users.set(id(user.id), user);
  }
  return tasks.flatMap((value) => {
    const task = record(value);
    if (!task || !isImprovement(task)) return [];
    return [
      {
        id: id(task.id),
        customId: text(task.custom_id) || null,
        name: text(task.name),
        url: text(task.url),
        owners: ownersOf(task, users),
      },
    ];
  });
}
