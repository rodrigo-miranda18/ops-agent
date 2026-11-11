import { Logger } from '@nestjs/common';
import type { IncidentIssueAssignment } from './google-chat.types.js';

export function githubLoginForEmail(email: string, userMapJson: string) {
  const mapping = githubChatUserMap(userMapJson);
  const normalized = new Map(
    Object.entries(mapping).map(([key, value]) => [
      key.trim().toLowerCase(),
      value,
    ]),
  );
  return normalized.get(email.trim().toLowerCase()) || null;
}

function githubChatUserMap(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('expected a JSON object');
    return parsed as Record<string, string>;
  } catch (error) {
    new Logger('GoogleChatService').error(
      `GITHUB_CHAT_USER_MAP is not a JSON object and was ignored; incidents will be assumed without a GitHub assignee: ${(error as Error).message}`,
    );
    return {};
  }
}

export function assignmentSummary(
  login: string | null,
  assignments: IncidentIssueAssignment[],
) {
  if (!login)
    return 'Nenhum usuário do GitHub mapeado para esse e-mail; as issues seguem sem assignee.';
  if (!assignments.length)
    return 'Nenhuma issue do GitHub vinculada a este incidente.';
  const label = (assignment: IncidentIssueAssignment) =>
    assignment.repository || assignment.url;
  const assigned = assignments
    .filter((assignment) => assignment.status === 'assigned')
    .map(label);
  const failed = assignments
    .filter((assignment) => assignment.status === 'failed')
    .map(label);
  const parts = [];
  if (assigned.length)
    parts.push(`Issues atribuídas a @${login}: ${assigned.join(', ')}.`);
  if (failed.length)
    parts.push(
      `Falha ao atribuir em ${failed.join(', ')}; atribua manualmente.`,
    );
  return parts.join(' ');
}
