export interface RemediationPullRequest {
  url: string;
  repository?: unknown;
  [key: string]: unknown;
}

export interface RemediationPullRequests {
  status?: unknown;
  pull_requests?: unknown;
}

function normalizeRepository(value: unknown): string {
  return String(value || '')
    .trim()
    .replace(/^repos\//i, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLocaleLowerCase('en-US');
}

function repositoryFromUrl(value: unknown): string {
  try {
    const url = new URL(String(value || ''));
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? normalizeRepository(parts[1]) : '';
  } catch {
    return '';
  }
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

export function pullRequestRepository(pullRequest: unknown): string {
  return (
    normalizeRepository(field(pullRequest, 'repository')) ||
    repositoryFromUrl(field(pullRequest, 'url'))
  );
}

export function replacementPullRequests(
  remediation: RemediationPullRequests | null | undefined,
): RemediationPullRequest[] {
  const pullRequests = Array.isArray(remediation?.pull_requests)
    ? (remediation.pull_requests as unknown[]).filter(
        (pullRequest): pullRequest is RemediationPullRequest => {
          const url = field(pullRequest, 'url');
          return typeof url === 'string' && Boolean(url.trim());
        },
      )
    : [];
  if (remediation?.status === 'PR_OPENED' && pullRequests.length >= 1) {
    return pullRequests;
  }
  if (
    remediation?.status === 'MULTIPLE_PRS_OPENED' &&
    pullRequests.length >= 2
  ) {
    return pullRequests;
  }
  return [];
}

export function selectSupersededPullRequests(
  previousRemediation: RemediationPullRequests | null | undefined,
  newRemediation: RemediationPullRequests | null | undefined,
): unknown[] {
  const replacements = replacementPullRequests(newRemediation);
  if (!replacements.length) return [];
  const replacementUrls = new Set(replacements.map(({ url }) => url.trim()));
  const replacedRepositories = new Set(
    replacements.map(pullRequestRepository).filter(Boolean),
  );
  const previous: unknown[] = Array.isArray(previousRemediation?.pull_requests)
    ? previousRemediation.pull_requests
    : [];
  return previous.filter((pullRequest) => {
    const rawUrl = field(pullRequest, 'url');
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    const repository = pullRequestRepository(pullRequest);
    return Boolean(
      url &&
      repository &&
      !replacementUrls.has(url) &&
      replacedRepositories.has(repository),
    );
  });
}
