import { sanitize } from '../common/sanitize.js';

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export const DRIVA_GITHUB_ORGANIZATION = 'Example-org';

const PULL_REQUEST_PATTERN =
  /(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;

export function extractPullRequestLinks(
  texts: readonly string[],
): PullRequestRef[] {
  const found = new Map<string, PullRequestRef>();
  for (const text of texts) {
    for (const [, owner, repo, n] of text.matchAll(PULL_REQUEST_PATTERN)) {
      const number = Number(n);
      const url = `https://github.com/${owner}/${repo}/pull/${number}`;
      const key = url.toLowerCase();
      if (!found.has(key)) {
        found.set(key, { owner, repo, number, url });
      }
    }
  }
  return [...found.values()];
}

export function isOrganizationPullRequest(
  ref: PullRequestRef,
  organization: string,
): boolean {
  return ref.owner.toLowerCase() === organization.toLowerCase();
}

export function sanitizePullRequestView(view: unknown): unknown {
  if (typeof view !== 'object' || view === null || Array.isArray(view))
    return view;
  const record = view as Record<string, unknown>;
  return {
    ...record,
    ...(typeof record.title !== 'string'
      ? {}
      : { title: sanitize(record.title) }),
    ...(typeof record.body !== 'string' ? {} : { body: sanitize(record.body) }),
  };
}
