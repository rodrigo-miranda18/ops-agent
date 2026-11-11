import { Inject, Injectable } from '@nestjs/common';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import {
  createGitHubExecutor,
  serviceGhError,
  type GitHubExecutor,
} from './gh.js';
import {
  GITHUB_CREDENTIAL_PROVIDER,
  type GitHubCredentialProvider,
} from './github-credentials.js';
import type { IssueStatus, PullRequestStatus } from './github.types.js';

@Injectable()
export class GithubService {
  execute: GitHubExecutor;

  constructor(
    @Inject(GITHUB_CREDENTIAL_PROVIDER)
    credentials: GitHubCredentialProvider,
    @Inject(RUNTIME_CONFIG) runtime: RuntimeConfig,
  ) {
    this.execute = createGitHubExecutor({
      credentials,
      timeoutMs: 60_000,
      baseEnv: runtime.processEnv,
      formatError: serviceGhError,
    });
  }

  assignIssue(issueUrl: string, login: string) {
    return this.execute(['issue', 'edit', issueUrl, '--add-assignee', login]);
  }

  commentIssue(issueUrl: string, body: string) {
    return this.execute(['issue', 'comment', issueUrl, '--body', body]);
  }

  async viewPullRequest(url: string): Promise<PullRequestStatus> {
    const output = await this.execute([
      'pr',
      'view',
      url,
      '--json',
      'state,updatedAt',
    ]);
    return parsePullRequestStatus(url, output);
  }

  closePullRequest(url: string, comment: string) {
    return this.execute([
      'pr',
      'close',
      url,
      '--delete-branch',
      '--comment',
      comment,
    ]);
  }

  async viewIssue(url: string): Promise<IssueStatus> {
    const output = await this.execute([
      'issue',
      'view',
      url,
      '--json',
      'state,updatedAt,assignees,comments',
    ]);
    return parseIssueStatus(url, output);
  }

  closeIssue(url: string, comment: string) {
    return this.execute([
      'issue',
      'close',
      url,
      '--reason',
      'not planned',
      '--comment',
      comment,
    ]);
  }
}

export function parsePullRequestStatus(
  url: string,
  output: string,
): PullRequestStatus {
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('state' in parsed) ||
    !('updatedAt' in parsed) ||
    typeof parsed.state !== 'string' ||
    typeof parsed.updatedAt !== 'string'
  )
    throw new Error(`Unexpected gh pr view output for ${url}`);
  return { url, state: parsed.state, updatedAt: parsed.updatedAt };
}

export function parseIssueStatus(url: string, output: string): IssueStatus {
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('state' in parsed) ||
    !('updatedAt' in parsed) ||
    !('assignees' in parsed) ||
    !('comments' in parsed) ||
    typeof parsed.state !== 'string' ||
    typeof parsed.updatedAt !== 'string' ||
    !Array.isArray(parsed.assignees) ||
    !Array.isArray(parsed.comments)
  )
    throw new Error(`Unexpected gh issue view output for ${url}`);
  return {
    url,
    state: parsed.state,
    updatedAt: parsed.updatedAt,
    assignees: parsed.assignees.flatMap((assignee: unknown) =>
      stringField(assignee, 'login'),
    ),
    commentBodies: parsed.comments.flatMap((comment: unknown) =>
      stringField(comment, 'body'),
    ),
  };
}

function stringField(value: unknown, key: string): string[] {
  if (typeof value !== 'object' || value === null || !(key in value)) return [];
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? [field] : [];
}
