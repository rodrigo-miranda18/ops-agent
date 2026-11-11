import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  readJsonArtifact,
  ticketResultsDir,
  updateRunArtifact,
} from '../diagnosis/diagnosis-artifacts.js';
import type { EngineeringAction } from '../diagnosis/diagnosis-output.js';
import type { RunnerDependencies } from '../runner/runner-dependencies.js';
import { runnerLogger } from '../runner/runner-logger.js';
import { projectDir, resultsDir } from '../runner/runner-paths.js';
import { writeJsonAtomic } from '../state/atomic-write.js';
import {
  replacementPullRequests,
  type RemediationPullRequest,
} from './remediation-reorientation.js';
import {
  closeSupersededPullRequests,
  runRemediation,
  type RemediationRunConfig,
  type RemediationTicket,
  type SupersededPullRequestResult,
} from './remediation-run.js';

interface RemediationReorientationRequest {
  [key: string]: unknown;
  id: string;
  ticketId: string;
  instruction: string;
  iteration: number;
  requestedByLabel?: unknown;
  space?: unknown;
  threadName?: unknown;
}

function isValidRequest(
  request: Record<string, unknown>,
): request is RemediationReorientationRequest {
  return Boolean(
    request.ticketId &&
    request.instruction &&
    Number.isInteger(request.iteration) &&
    (request.iteration as number) >= 1,
  );
}

function pullRequestList(value: unknown): RemediationPullRequest[] {
  return Array.isArray(value) ? (value as RemediationPullRequest[]) : [];
}

export async function runRemediationReorientation(
  config: RemediationRunConfig,
  reorientationId: string | undefined,
  dependencies: RunnerDependencies,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(reorientationId || ''))
    throw new Error('Invalid remediation reorientation ID');
  const requests = JSON.parse(
    await readFile(
      path.join(projectDir, 'state', 'remediation-reorientations.json'),
      'utf8',
    ),
  ) as Record<string, Record<string, unknown> | undefined>;
  const request = requests[reorientationId as string];
  if (!request || request.id !== reorientationId)
    throw new Error('Remediation reorientation request was not found');
  if (!isValidRequest(request)) {
    throw new Error('Remediation reorientation request is invalid');
  }

  const ticketDir = ticketResultsDir(resultsDir, request.ticketId);
  const iterationDir = path.join(
    ticketDir,
    'remediations',
    String(request.iteration).padStart(3, '0'),
  );
  const ticket = (await readJsonArtifact(
    ticketDir,
    'ticket.json',
  )) as RemediationTicket;
  const action = (await readJsonArtifact(
    ticketDir,
    'engineering-action.json',
  )) as EngineeringAction;
  const previousRemediation = (await readJsonArtifact(
    ticketDir,
    'remediation.json',
  )) as Record<string, unknown>;
  const supersedablePullRequests = Array.isArray(
    previousRemediation.supersedable_pull_requests,
  )
    ? pullRequestList(previousRemediation.supersedable_pull_requests)
    : pullRequestList(previousRemediation.pull_requests);
  await writeJsonAtomic(path.join(iterationDir, 'request.json'), request);
  await writeJsonAtomic(
    path.join(iterationDir, 'previous-remediation.json'),
    previousRemediation,
  );

  const remediation = await runRemediation(
    config,
    ticketDir,
    ticket,
    action,
    'auto',
    {
      force: true,
      instruction: request.instruction,
      branchKey: request.id,
      previousRemediation,
    },
    dependencies,
  );
  const replacements = replacementPullRequests(remediation);
  let cleanupResults: SupersededPullRequestResult[] = [];
  if (replacements.length) {
    cleanupResults = await closeSupersededPullRequests(
      { ...previousRemediation, pull_requests: supersedablePullRequests },
      remediation,
      `pela reorientação ${request.iteration}`,
      dependencies.github,
    );
    remediation.superseded_pull_requests = cleanupResults;
  }
  const failedCleanupUrls = new Set(
    cleanupResults
      .filter(({ status }) => status === 'failed')
      .map(({ url }) => url),
  );
  const unresolvedPreviousPullRequests = supersedablePullRequests.filter(
    ({ url }) => failedCleanupUrls.has(url),
  );
  remediation.supersedable_pull_requests = replacements.length
    ? [
        ...(remediation.pull_requests as unknown[]),
        ...unresolvedPreviousPullRequests,
      ]
    : supersedablePullRequests;
  remediation.reorientation = {
    id: request.id,
    iteration: request.iteration,
    instruction: request.instruction,
    requested_by: request.requestedByLabel,
  };
  await writeJsonAtomic(path.join(ticketDir, 'remediation.json'), remediation);
  await writeJsonAtomic(
    path.join(iterationDir, 'remediation.json'),
    remediation,
  );

  await updateRunArtifact(ticketDir, {
    remediation_mode: 'auto',
    remediation_status: remediation.status,
    remediation_iteration: request.iteration,
    remediation_broadcast_to_bound_threads: true,
    google_chat_space: request.space,
    google_chat_thread: request.threadName,
    notify: true,
    status: 'success',
    finished_at: new Date().toISOString(),
  });
  runnerLogger.info(
    `Completed remediation reorientation ${reorientationId}; iteration=${request.iteration}`,
  );
}
