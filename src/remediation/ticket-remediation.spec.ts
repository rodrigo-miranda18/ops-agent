import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { EngineeringAction } from '../diagnosis/diagnosis-output.js';
import type { IncidentGitHub } from '../incidents/incident-issues.js';
import type { RunnerDependencies } from '../runner/runner-dependencies.js';
import type { RemediationRunConfig } from './remediation-run.js';
import {
  previousTicketPullRequests,
  remediateTicket,
} from './ticket-remediation.js';

const hubPr = 'https://github.com/example/service-17/pull/3377';
const mailPr = 'https://github.com/example/service-15/pull/12';

function action(repositories: string[]): EngineeringAction {
  return {
    decision: 'CORRECTION_REQUIRED',
    confidence: 'high',
    summary: 'Causa confirmada',
    reason: 'Correção necessária',
    repositories: repositories.map((name) => ({ name })),
  };
}

async function setup(previousRemediation: unknown) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ticket-remediation-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  if (previousRemediation !== undefined)
    await writeFile(
      path.join(directory, 'remediation.json'),
      JSON.stringify(previousRemediation),
    );
  const fixture = path.resolve(
    'src/incidents/fixtures/codex-response-correction-required.js',
  );
  await chmod(fixture, 0o755);
  const config = {
    reposDir: directory,
    repositorySyncTimeoutMs: 10000,
    codexBin: fixture,
    codexTimeoutMs: 10000,
    remediationTimeoutMs: 10000,
  } as unknown as RemediationRunConfig;
  return { directory, config };
}

function githubWithStates(states: Record<string, string>): IncidentGitHub {
  return async (args) =>
    args[0] === 'pr' && args[1] === 'view' ? states[args[2]] || '' : '';
}

function dependencies(github: IncidentGitHub): RunnerDependencies {
  return {
    github,
    ensureGitHubAccess: async () => undefined,
  };
}

describe('previousTicketPullRequests', () => {
  it('prefers the supersedable pull requests kept by a reused remediation', () => {
    // Act
    const pullRequests = previousTicketPullRequests({
      pull_requests: [{ repository: 'service-17', url: hubPr }],
      supersedable_pull_requests: [
        { repository: 'service-17', url: hubPr },
        { repository: 'service-15', url: mailPr },
      ],
    });
    // Assert
    expect(pullRequests).toStrictEqual([
      { repository: 'service-17', url: hubPr },
      { repository: 'service-15', url: mailPr },
    ]);
  });

  it('ignores entries without URL and duplicated URLs', () => {
    // Act
    const pullRequests = previousTicketPullRequests({
      pull_requests: [
        { repository: 'service-17', url: hubPr },
        { repository: 'service-17', url: hubPr },
        { repository: 'service-15', url: ' ' },
        'invalid',
      ],
    });
    // Assert
    expect(pullRequests).toStrictEqual([
      { repository: 'service-17', url: hubPr },
    ]);
  });

  it('returns nothing without a previous remediation', () => {
    expect(previousTicketPullRequests(null)).toStrictEqual([]);
  });
});

describe('remediateTicket', () => {
  it('keeps the open pull requests of the previous remediation instead of opening new ones', async () => {
    // Arrange
    const { directory, config } = await setup({
      pull_requests: [{ repository: 'service-17', url: hubPr }],
    });
    // Act
    const remediation = await remediateTicket(
      config,
      directory,
      { id: '86tkt0001' },
      action(['service-17']),
      'auto',
      dependencies(githubWithStates({ [hubPr]: 'OPEN' })),
    );
    // Assert
    expect(remediation.recurrence_reused).toBe(true);
    expect(remediation.status).toBe('PR_OPENED');
    expect(remediation.pull_requests).toStrictEqual([
      { repository: 'service-17', url: hubPr, depends_on: [] },
    ]);
    expect(remediation.reason).toContain(hubPr);
    await expect(
      readFile(path.join(directory, 'captured-prompt.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  it('sends the still open pull requests to the remediation when a repository is not covered', async () => {
    // Arrange
    const { directory, config } = await setup({
      pull_requests: [
        { repository: 'service-17', url: hubPr },
        { repository: 'service-15', url: mailPr },
      ],
    });
    // Act
    const remediation = await remediateTicket(
      config,
      directory,
      { id: '86tkt0001' },
      action(['service-17', 'service-15']),
      'auto',
      dependencies(githubWithStates({ [hubPr]: 'OPEN', [mailPr]: 'MERGED' })),
    );
    // Assert
    expect(remediation.recurrence_reused).toBe(undefined);
    const prompt = await readFile(
      path.join(directory, 'captured-prompt.txt'),
      'utf8',
    );
    expect(prompt).toContain(hubPr);
    expect(prompt).not.toContain(mailPr);
  });

  it('remediates from scratch when there is no previous remediation', async () => {
    // Arrange
    const { directory, config } = await setup(undefined);
    // Act
    await remediateTicket(
      config,
      directory,
      { id: '86tkt0001' },
      action(['service-17']),
      'auto',
      dependencies(githubWithStates({})),
    );
    // Assert
    const prompt = await readFile(
      path.join(directory, 'captured-prompt.txt'),
      'utf8',
    );
    expect(prompt).toMatch(
      /PRs de remediação já abertos para este problema, quando houver:\s*null/,
    );
  });
});
