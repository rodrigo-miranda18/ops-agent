#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { fetchComments, fetchTask, fetchTasks } from './clickup/clickup-api.js';
import {
  evaluateTickets,
  filterMismatchCounts,
  selectEligibleTickets,
  ticketSummary,
} from './clickup/ticket-selection.js';
import { sanitize } from './common/sanitize.js';
import { loadDotEnv } from './config/env.js';
import { runnerConfigFromEnv } from './config/runner-config.js';
import { ticketResultsDir } from './diagnosis/diagnosis-artifacts.js';
import { itemKey, withItemClaim } from './diagnosis/item-claims.js';
import { readResumeCheckpoint } from './diagnosis/resume-checkpoint.js';
import {
  isProcessedTicketVersion,
  processTicket,
  readProcessed,
  resumeTicketAfterDiagnosis,
  type TicketProcessingConfig,
} from './diagnosis/ticket-processing.js';
import { renderDiagnosisVectorPrompt } from './diagnosis/vector-classification.js';
import { withRepositoryAccess } from './git/repository-access.js';
import {
  processIncident,
  resumeIncidentAfterDiagnosis,
  type IncidentInput,
} from './incidents/incident-processing.js';
import { runRemediationReorientation } from './remediation/remediation-reorientation-run.js';
import { parseArgs, printHelp } from './runner/runner-args.js';
import { createRunnerDependencies } from './runner/runner-dependencies.js';
import { runnerLogger } from './runner/runner-logger.js';
import {
  projectDir,
  resultsDir,
  runnerDir,
  stateDir,
} from './runner/runner-paths.js';
import { createInstanceId } from './state/owner-identity.js';
import {
  releaseAllOwnedLocks,
  type OwnedLockOwner,
} from './state/owned-lock.js';

export {
  ensureIncidentIssues,
  incidentIssueIdentity,
  incidentRecurrenceCoverage,
  linkedIncidentPullRequests,
  openIncidentPullRequests,
} from './incidents/incident-issues.js';
export { processIncident } from './incidents/incident-processing.js';

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    }),
  );
}

function executionOwner(ownerInstanceId: string | undefined): OwnedLockOwner {
  const timestamp = new Date().toISOString();
  return {
    instanceId: ownerInstanceId || createInstanceId('runner'),
    pid: process.pid,
    startedAt: timestamp,
    heartbeatAt: timestamp,
  };
}

function sendItemMessage(type: 'item-started' | 'item-finished', key: string) {
  process.send?.({ type, key });
}

async function reorientationTicketId(reorientationId: string): Promise<string> {
  const records = JSON.parse(
    await readFile(
      path.join(stateDir, 'remediation-reorientations.json'),
      'utf8',
    ),
  ) as Record<string, { ticketId?: unknown } | undefined>;
  const ticketId = records[reorientationId]?.ticketId;
  if (typeof ticketId !== 'string' || !ticketId)
    throw new Error('Remediation reorientation request is invalid');
  return ticketId;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.resume) args.force = true;
  await loadDotEnv(path.join(projectDir, '.env'));
  const config = runnerConfigFromEnv(args) as TicketProcessingConfig;
  const dependencies = createRunnerDependencies(config, process.env);
  const owner = executionOwner(args.ownerInstanceId);

  if (args.incidentId) {
    const incidents = JSON.parse(
      await readFile(path.join(stateDir, 'incidents.json'), 'utf8'),
    ) as Record<string, IncidentInput | undefined>;
    const incident = incidents[args.incidentId];
    if (!incident) throw new Error(`Incident not found: ${args.incidentId}`);
    if (incident.status === 'resolved' && !args.force) return;
    await withRepositoryAccess(
      config,
      { stateDir, owner },
      async (syncInfo) => {
        const key = itemKey({ incidentId: args.incidentId });
        if (!key) throw new Error('Incident item key is missing');
        await withItemClaim(
          { stateDir, key, owner, batch: false },
          async () => {
            const checkpoint = args.resume
              ? await readResumeCheckpoint(
                  ticketResultsDir(resultsDir, incident.incidentId),
                )
              : 'restart';
            if (checkpoint === 'diagnosis-complete') {
              await resumeIncidentAfterDiagnosis(
                config,
                incident.incidentId,
                args,
                dependencies,
              );
              return;
            }
            const promptTemplate = renderDiagnosisVectorPrompt(
              await readFile(
                path.join(runnerDir, 'prompts', 'prompt.md'),
                'utf8',
              ),
              config.diagnosisVectors,
            );
            await processIncident(
              config,
              incident,
              promptTemplate,
              args,
              dependencies,
              syncInfo,
            );
          },
        );
      },
    );
    return;
  }

  if (args.reorientationId) {
    const ticketId = await reorientationTicketId(args.reorientationId);
    await withRepositoryAccess(config, { stateDir, owner }, async () => {
      const key = itemKey({ reorientationTicketId: ticketId });
      if (!key) throw new Error('Reorientation item key is missing');
      await withItemClaim({ stateDir, key, owner, batch: false }, () =>
        runRemediationReorientation(config, args.reorientationId, dependencies),
      );
    });
    return;
  }

  if (args.syncDependenciesOnly) {
    await withRepositoryAccess(
      config,
      { stateDir, owner, syncOnly: true },
      async () => undefined,
    );
    return;
  }

  const processed = await readProcessed();
  runnerLogger.info(
    `Fetching ClickUp tickets; ticket-id=${args.ticketId || 'automatic'}; dry-run=${args.dryRun}; remediation=${args.remediation}; force=${args.force}; max=${config.maxTickets}; concurrency=${config.concurrency}`,
  );
  const tasks = args.ticketId
    ? [await fetchTask(config, args.ticketId)]
    : await fetchTasks(config);
  const evaluated = evaluateTickets(tasks, config, Boolean(args.ticketId));
  const matched = evaluated.filter((item) => item.matches);
  const rejected = evaluated.length - matched.length;
  runnerLogger.info(
    `Fetched ${tasks.length}; matched open/recent configured-area bug filter ${matched.length}; rejected ${rejected}`,
  );
  if (!matched.length)
    runnerLogger.info(
      `Filter mismatch counts: ${JSON.stringify(filterMismatchCounts(evaluated, config))}`,
    );

  const eligible = selectEligibleTickets(matched, processed, {
    force: args.force,
    maxTickets: config.maxTickets,
  });
  if (!eligible.length) {
    runnerLogger.info('No eligible tickets to process.');
    return;
  }
  if (args.dryRun) {
    for (const ticket of eligible)
      runnerLogger.info(JSON.stringify(ticketSummary(ticket)));
    return;
  }

  await withRepositoryAccess(config, { stateDir, owner }, async (syncInfo) => {
    const promptTemplate = renderDiagnosisVectorPrompt(
      await readFile(path.join(runnerDir, 'prompts', 'prompt.md'), 'utf8'),
      config.diagnosisVectors,
    );
    let failures = 0;
    await runWithConcurrency(
      eligible,
      config.concurrency,
      async ({ task, actual }) => {
        const taskId = String(task.id);
        const key = itemKey({ ticketId: taskId });
        if (!key) throw new Error('Ticket item key is missing');
        try {
          const result = await withItemClaim(
            { stateDir, key, owner, batch: !args.ticketId },
            async () => {
              sendItemMessage('item-started', key);
              try {
                const checkpoint = args.resume
                  ? await readResumeCheckpoint(
                      ticketResultsDir(resultsDir, taskId),
                    )
                  : 'restart';
                if (checkpoint === 'diagnosis-complete') {
                  await resumeTicketAfterDiagnosis(
                    config,
                    taskId,
                    args,
                    dependencies,
                    owner,
                  );
                  return;
                }
                if (
                  !args.force &&
                  isProcessedTicketVersion(await readProcessed(), task)
                ) {
                  runnerLogger.info(
                    `Skipping ${taskId}: this ticket version was processed by another execution`,
                  );
                  return;
                }
                runnerLogger.info(`Processing ${taskId}: ${task.name}`);
                const detailedTask = await fetchTask(config, taskId);
                const comments = await fetchComments(config, taskId);
                await processTicket(
                  config,
                  detailedTask,
                  comments,
                  actual,
                  promptTemplate,
                  args,
                  dependencies,
                  syncInfo,
                  owner,
                );
                runnerLogger.info(
                  `Completed ${taskId}; result saved under results/${taskId}/`,
                );
              } finally {
                sendItemMessage('item-finished', key);
              }
            },
          );
          if (result.status === 'skipped')
            runnerLogger.info(`Skipping ${taskId}: item claim is active`);
        } catch (error) {
          if (args.ticketId) throw error;
          failures += 1;
          runnerLogger.error(
            `Failed ${taskId}: ${sanitize((error as Error).message)}`,
          );
        }
      },
    );
    if (failures) throw new Error(`${failures} ticket(s) failed`);
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.once('SIGTERM', () => {
    void releaseAllOwnedLocks().finally(() => process.exit(143));
  });
  main().catch((error: Error) => {
    runnerLogger.error(`Runner failed: ${sanitize(error.message)}`);
    process.exitCode = 1;
  });
}
