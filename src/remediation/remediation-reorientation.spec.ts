import { beforeEach, expect, it, vi } from 'vitest';
import type { RunnerDependencies } from '../runner/runner-dependencies.js';

const readFileMock = vi.hoisted(() => vi.fn());
const readJsonArtifactMock = vi.hoisted(() => vi.fn());
const updateRunArtifactMock = vi.hoisted(() => vi.fn());
const writeJsonAtomicMock = vi.hoisted(() => vi.fn());
const runRemediationMock = vi.hoisted(() => vi.fn());
const closeSupersededMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }));
vi.mock('../diagnosis/diagnosis-artifacts.js', () => ({
  readJsonArtifact: readJsonArtifactMock,
  ticketResultsDir: (_directory: string, ticketId: string) =>
    `/results/${ticketId}`,
  updateRunArtifact: updateRunArtifactMock,
}));
vi.mock('../state/atomic-write.js', () => ({
  writeJsonAtomic: writeJsonAtomicMock,
}));
vi.mock('./remediation-run.js', () => ({
  runRemediation: runRemediationMock,
  closeSupersededPullRequests: closeSupersededMock,
}));
import {
  replacementPullRequests,
  selectSupersededPullRequests,
} from './remediation-reorientation.js';

beforeEach(() => {
  readFileMock.mockReset();
  readJsonArtifactMock.mockReset();
  updateRunArtifactMock.mockReset().mockResolvedValue(undefined);
  writeJsonAtomicMock.mockReset().mockResolvedValue(undefined);
  runRemediationMock.mockReset();
  closeSupersededMock.mockReset();
});

it('selects only old PRs whose repository received a successful replacement', () => {
  // Arrange
  const previous = {
    pull_requests: [
      {
        repository: 'service-a',
        url: 'https://github.com/driva/service-a/pull/10',
      },
      {
        repository: 'service-b',
        url: 'https://github.com/driva/service-b/pull/20',
      },
    ],
  };
  const current = {
    status: 'PR_OPENED',
    pull_requests: [
      {
        repository: 'service-a',
        url: 'https://github.com/driva/service-a/pull/11',
      },
    ],
  };

  // Act
  const selected = selectSupersededPullRequests(previous, current);

  // Assert
  expect(selected).toStrictEqual([previous.pull_requests[0]]);
});

it('does not supersede old PRs when the replacement result is incomplete', () => {
  // Arrange
  const previous = {
    pull_requests: [
      {
        repository: 'service-a',
        url: 'https://github.com/driva/service-a/pull/10',
      },
    ],
  };
  const current = {
    status: 'IMPLEMENTATION_FAILED',
    pull_requests: [
      {
        repository: 'service-a',
        url: 'https://github.com/driva/service-a/pull/11',
      },
    ],
  };

  // Act
  const selected = selectSupersededPullRequests(previous, current);

  // Assert
  expect(selected).toStrictEqual([]);
});

it('requires at least two PR URLs before accepting a multiple-PR result as complete', () => {
  // Arrange
  const current = {
    status: 'MULTIPLE_PRS_OPENED',
    pull_requests: [
      {
        repository: 'service-a',
        url: 'https://github.com/driva/service-a/pull/11',
      },
    ],
  };

  // Act
  const replacements = replacementPullRequests(current);

  // Assert
  expect(replacements).toStrictEqual([]);
});

it('uses the same GitHub executor for reorientation and superseded PR cleanup', async () => {
  const github = vi.fn(async () => '');
  const dependencies: RunnerDependencies = {
    github,
    ensureGitHubAccess: vi.fn(async () => undefined),
  };
  const previousRemediation = {
    pull_requests: [
      {
        repository: 'service-a',
        url: 'https://github.com/driva/service-a/pull/10',
      },
    ],
  };
  readFileMock.mockResolvedValue(
    JSON.stringify({
      reorientation: {
        id: 'reorientation',
        ticketId: 'ticket-1',
        instruction: 'Try another approach',
        iteration: 1,
      },
    }),
  );
  readJsonArtifactMock
    .mockResolvedValueOnce({ id: 'ticket-1' })
    .mockResolvedValueOnce({
      decision: 'CORRECTION_REQUIRED',
      confidence: 'high',
      summary: 'Fix',
      reason: 'Cause',
      repositories: [{ name: 'service-a' }],
    })
    .mockResolvedValueOnce(previousRemediation);
  const remediation = {
    status: 'PR_OPENED',
    pull_requests: [
      {
        repository: 'service-a',
        url: 'https://github.com/driva/service-a/pull/11',
      },
    ],
  };
  runRemediationMock.mockResolvedValue(remediation);
  closeSupersededMock.mockResolvedValue([]);

  const { runRemediationReorientation } =
    await import('./remediation-reorientation-run.js');
  await runRemediationReorientation(
    {
      reposDir: '/repos',
      codexBin: 'codex',
      codexModel: undefined,
      codexTimeoutMs: 1000,
      remediationTimeoutMs: 2000,
      repositorySyncTimeoutMs: 3000,
    },
    'reorientation',
    dependencies,
  );

  expect(runRemediationMock).toHaveBeenCalledWith(
    expect.anything(),
    '/results/ticket-1',
    { id: 'ticket-1' },
    expect.anything(),
    'auto',
    expect.anything(),
    dependencies,
  );
  expect(closeSupersededMock).toHaveBeenCalledWith(
    expect.anything(),
    remediation,
    'pela reorientação 1',
    github,
  );
});
