import type { PullRequestStatus } from '../github/github.types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function pullRequestUrlsFromRemediation(remediation: unknown): string[] {
  if (!isRecord(remediation) || !Array.isArray(remediation.pull_requests))
    return [];
  return remediation.pull_requests.flatMap((pr: unknown) =>
    isRecord(pr) && typeof pr.url === 'string' && pr.url.trim()
      ? [pr.url.trim()]
      : [],
  );
}

export function isStalePullRequest(
  pr: PullRequestStatus,
  now: Date,
  maxAgeDays: number,
): boolean {
  return pr.state === 'OPEN' && isInactiveFor(pr.updatedAt, now, maxAgeDays);
}

export function isInactiveFor(
  updatedAt: string,
  now: Date,
  maxAgeDays: number,
): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedAtMs)) return false;
  return now.getTime() - updatedAtMs >= maxAgeDays * DAY_MS;
}

export function stalePullRequestComment(maxAgeDays: number): string {
  return `Fechado automaticamente pelo Driva Ops Agent: sem atividade há ${maxAgeDays} dias ou mais. A branch foi removida; reabra o PR e restaure a branch se a correção ainda for necessária.`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
