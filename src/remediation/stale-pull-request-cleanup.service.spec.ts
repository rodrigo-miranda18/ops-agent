import { Logger } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { GithubService } from '../github/github.service.js';
import type { IssueStatus, PullRequestStatus } from '../github/github.types.js';
import { incidentPullRequestLinkComment } from '../incidents/incident-pull-request-links.js';
import { StalePullRequestCleanupService } from './stale-pull-request-cleanup.service.js';

const now = new Date('2026-09-28T12:00:00Z');
const stale = 'https://github.com/org/repo/pull/1';
const fresh = 'https://github.com/org/repo/pull/2';
const merged = 'https://github.com/org/repo/pull/3';
const broken = 'https://github.com/org/repo/pull/4';

const statuses: Record<string, Omit<PullRequestStatus, 'url'>> = {
  [stale]: { state: 'OPEN', updatedAt: '2026-09-01T12:00:00Z' },
  [fresh]: { state: 'OPEN', updatedAt: '2026-09-27T12:00:00Z' },
  [merged]: { state: 'MERGED', updatedAt: '2026-08-01T12:00:00Z' },
};

const staleIssue = 'https://github.com/org/repo/issues/10';
const assignedIssue = 'https://github.com/org/repo/issues/11';
const linkedOpenIssue = 'https://github.com/org/repo/issues/12';
const freshIssue = 'https://github.com/org/repo/issues/13';
const linkedClosedIssue = 'https://github.com/org/repo/issues/14';

const idleIssue = {
  state: 'OPEN',
  updatedAt: '2026-08-01T12:00:00Z',
  assignees: [],
  commentBodies: [],
};
const issueStatuses: Record<string, Omit<IssueStatus, 'url'>> = {
  [staleIssue]: idleIssue,
  [assignedIssue]: { ...idleIssue, assignees: ['ana'] },
  [linkedOpenIssue]: {
    ...idleIssue,
    commentBodies: [incidentPullRequestLinkComment([fresh])],
  },
  [freshIssue]: { ...idleIssue, updatedAt: '2026-09-20T12:00:00Z' },
  [linkedClosedIssue]: {
    ...idleIssue,
    commentBodies: [incidentPullRequestLinkComment([merged])],
  },
};

describe('StalePullRequestCleanupService', () => {
  let resultsDir: string;
  let github: {
    viewPullRequest: ReturnType<typeof vi.fn>;
    closePullRequest: ReturnType<typeof vi.fn>;
    viewIssue: ReturnType<typeof vi.fn>;
    closeIssue: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    resultsDir = await mkdtemp(path.join(tmpdir(), 'stale-prs-'));
    github = {
      viewPullRequest: vi.fn((url: string) => {
        const status = statuses[url];
        return status
          ? Promise.resolve({ url, ...status })
          : Promise.reject(new Error('gh failed'));
      }),
      closePullRequest: vi.fn().mockResolvedValue(''),
      viewIssue: vi.fn((url: string) => {
        const status = issueStatuses[url];
        return status
          ? Promise.resolve({ url, ...status })
          : Promise.reject(new Error('gh failed'));
      }),
      closeIssue: vi.fn().mockResolvedValue(''),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(resultsDir, { recursive: true, force: true });
  });

  const service = (dir = resultsDir) =>
    new StalePullRequestCleanupService(
      github as unknown as GithubService,
      { stalePrMaxAgeDays: 14, staleIssueMaxAgeDays: 30 } as AppConfig,
      { resultsDir: dir } as RuntimeConfig,
    );

  const writeRemediation = async (relative: string, urls: string[]) => {
    const file = path.join(resultsDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ pull_requests: urls.map((url) => ({ url })) }),
    );
  };

  it('closes only stale open pull requests recorded by the agent', async () => {
    await writeRemediation('T-1/remediation.json', [stale, fresh]);
    await writeRemediation('T-2/iterations/1/remediation.json', [
      merged,
      stale,
    ]);
    await writeRemediation('T-3/previous-remediation.json', [broken]);
    await writeFile(path.join(resultsDir, 'T-1', 'bad.json'), '{');

    const summary = await service().cleanup(now);

    expect(summary).toMatchObject({ checked: 3, closed: [stale], failed: 0 });
    expect(github.closePullRequest).toHaveBeenCalledTimes(1);
    expect(github.closePullRequest).toHaveBeenCalledWith(
      stale,
      expect.stringContaining('14 dias'),
    );
  });

  it('keeps going when one pull request fails', async () => {
    await writeRemediation('T-1/remediation.json', [broken, stale]);

    const summary = await service().cleanup(now);

    expect(summary).toMatchObject({ checked: 2, closed: [stale], failed: 1 });
  });

  it('skips remediation files with invalid JSON', async () => {
    await mkdir(path.join(resultsDir, 'T-1'), { recursive: true });
    await writeFile(path.join(resultsDir, 'T-1', 'remediation.json'), '{');
    await writeRemediation('T-2/remediation.json', [stale]);

    const summary = await service().cleanup(now);

    expect(summary.closed).toEqual([stale]);
  });

  it('does nothing when the results directory does not exist', async () => {
    const summary = await service(path.join(resultsDir, 'missing')).cleanup(
      now,
    );

    expect(summary).toEqual({
      checked: 0,
      closed: [],
      issuesChecked: 0,
      issuesClosed: [],
      failed: 0,
    });
    expect(github.viewPullRequest).not.toHaveBeenCalled();
    expect(github.viewIssue).not.toHaveBeenCalled();
  });

  const writeIssues = async (relative: string, urls: string[]) => {
    const file = path.join(resultsDir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        urls.map((url) => ({ repository: 'repo', name: 'Repo', url })),
      ),
    );
  };

  it('closes stale unassigned issues without an open linked pull request', async () => {
    await writeIssues('T-1/github-issues.json', [
      staleIssue,
      assignedIssue,
      linkedOpenIssue,
    ]);
    await writeIssues('T-2/github-issues.json', [
      freshIssue,
      linkedClosedIssue,
      staleIssue,
    ]);

    const summary = await service().cleanup(now);

    expect(summary).toEqual({
      checked: 0,
      closed: [],
      issuesChecked: 5,
      issuesClosed: expect.arrayContaining([staleIssue, linkedClosedIssue]),
      failed: 0,
    });
    expect(github.closeIssue).toHaveBeenCalledTimes(2);
    expect(github.closeIssue).toHaveBeenCalledWith(
      staleIssue,
      expect.stringContaining('30 dias'),
    );
    expect(github.closePullRequest).not.toHaveBeenCalled();
  });

  it('keeps going when one issue fails', async () => {
    await writeIssues('T-1/github-issues.json', [
      'https://github.com/org/repo/issues/99',
      staleIssue,
    ]);

    const summary = await service().cleanup(now);

    expect(summary).toMatchObject({ issuesClosed: [staleIssue], failed: 1 });
  });
});
