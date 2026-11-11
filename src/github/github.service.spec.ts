import { describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { GitHubCredentialProvider } from './github-credentials.js';
import {
  GithubService,
  parseIssueStatus,
  parsePullRequestStatus,
} from './github.service.js';

const credentials: GitHubCredentialProvider = {
  getCredential: vi.fn(async () => ({
    token: 'token',
    expiresAt: null,
    installationId: null,
  })),
  invalidate: vi.fn(),
};
const runtime = { processEnv: { PATH: '/usr/bin' } } as RuntimeConfig;
const createService = () => new GithubService(credentials, runtime);

const url = 'https://github.com/org/repo/pull/7';

describe('GithubService pull requests', () => {
  it('reads state and updatedAt of a pull request', async () => {
    const github = createService();
    github.execute = vi
      .fn()
      .mockResolvedValue('{"state":"OPEN","updatedAt":"2026-09-01T10:00:00Z"}');
    await expect(github.viewPullRequest(url)).resolves.toEqual({
      url,
      state: 'OPEN',
      updatedAt: '2026-09-01T10:00:00Z',
    });
    expect(github.execute).toHaveBeenCalledWith([
      'pr',
      'view',
      url,
      '--json',
      'state,updatedAt',
    ]);
  });

  it('closes a pull request with a comment and deletes its branch', async () => {
    const github = createService();
    github.execute = vi.fn().mockResolvedValue('');
    await github.closePullRequest(url, 'bye');
    expect(github.execute).toHaveBeenCalledWith([
      'pr',
      'close',
      url,
      '--delete-branch',
      '--comment',
      'bye',
    ]);
  });

  it.each(['{}', '{"state":"OPEN"}', '{"state":1,"updatedAt":"x"}', 'null'])(
    'rejects unexpected gh output %s',
    (output) => {
      expect(() => parsePullRequestStatus(url, output)).toThrow(
        `Unexpected gh pr view output for ${url}`,
      );
    },
  );
});

const issueUrl = 'https://github.com/org/repo/issues/3';

describe('GithubService issues', () => {
  it('reads state, activity, assignee logins and comment bodies of an issue', async () => {
    const github = createService();
    github.execute = vi.fn().mockResolvedValue(
      JSON.stringify({
        state: 'OPEN',
        updatedAt: '2026-09-01T10:00:00Z',
        assignees: [{ login: 'ana', name: 'Ana' }, { id: 1 }],
        comments: [{ body: 'primeiro' }, { author: {} }],
      }),
    );
    await expect(github.viewIssue(issueUrl)).resolves.toEqual({
      url: issueUrl,
      state: 'OPEN',
      updatedAt: '2026-09-01T10:00:00Z',
      assignees: ['ana'],
      commentBodies: ['primeiro'],
    });
    expect(github.execute).toHaveBeenCalledWith([
      'issue',
      'view',
      issueUrl,
      '--json',
      'state,updatedAt,assignees,comments',
    ]);
  });

  it('closes an issue as not planned with a comment', async () => {
    const github = createService();
    github.execute = vi.fn().mockResolvedValue('');
    await github.closeIssue(issueUrl, 'bye');
    expect(github.execute).toHaveBeenCalledWith([
      'issue',
      'close',
      issueUrl,
      '--reason',
      'not planned',
      '--comment',
      'bye',
    ]);
  });

  it.each([
    '{}',
    '{"state":"OPEN","updatedAt":"x","assignees":[]}',
    '{"state":"OPEN","updatedAt":"x","assignees":{},"comments":[]}',
    'null',
  ])('rejects unexpected gh output %s', (output) => {
    expect(() => parseIssueStatus(issueUrl, output)).toThrow(
      `Unexpected gh issue view output for ${issueUrl}`,
    );
  });
});
