import type { IssueStatus } from '../github/github.types.js';
import { isInactiveFor, isRecord } from './stale-pull-requests.js';

export function issueUrlsFromIncidentIssues(issues: unknown): string[] {
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) =>
    isRecord(issue) && typeof issue.url === 'string' && issue.url.trim()
      ? [issue.url.trim()]
      : [],
  );
}

export function isStaleIssue(
  issue: IssueStatus,
  now: Date,
  maxAgeDays: number,
): boolean {
  return (
    issue.state === 'OPEN' &&
    issue.assignees.length === 0 &&
    isInactiveFor(issue.updatedAt, now, maxAgeDays)
  );
}

export function staleIssueComment(maxAgeDays: number): string {
  return `Fechado automaticamente pelo Driva Ops Agent: o incidente não se repetiu nos últimos ${maxAgeDays} dias. Se voltar a ocorrer, uma nova issue será aberta.`;
}
