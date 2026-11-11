import type { CommunicationTask } from './communication-store.js';

function optionalString(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim() || null
    : null;
}

export function communicationTask(
  task: Record<string, unknown>,
  linkTeamId: string | undefined,
): CommunicationTask {
  const id = optionalString(task.id);
  if (!id) throw new Error('O ClickUp não retornou o ID interno do ticket.');
  const url = optionalString(task.url) ?? `https://app.clickup.com/t/${id}`;
  return {
    id,
    customId: optionalString(task.custom_id),
    name: optionalString(task.name) ?? '',
    url,
    teamId: optionalString(task.team_id) ?? linkTeamId ?? null,
  };
}
