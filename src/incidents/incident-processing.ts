import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { codexHomeDir, type RunnerConfig } from '../config/runner-config.js';
import {
  ticketResultsDir,
  updateRunArtifact,
  writeStderrArtifact,
  writeTextArtifact,
} from '../diagnosis/diagnosis-artifacts.js';
import {
  extractOutput,
  shouldRemediate,
  type DiagnosisOutput,
} from '../diagnosis/diagnosis-output.js';
import { renderTicketPrompt } from '../diagnosis/diagnosis-prompt.js';
import { isIncidentNotificationAck } from '../diagnosis/runner-messages.js';
import { findGitRepositories } from '../git/git.js';
import type { RepositorySyncInfo } from '../git/repository-access.js';
import { persistCurrentImpact } from '../impact/impact-persistence.js';
import { replacementPullRequests } from '../remediation/remediation-reorientation.js';
import {
  closeSupersededPullRequests,
  runRemediation,
  type RemediationResult,
  type RemediationRunConfig,
} from '../remediation/remediation-run.js';
import type { RunnerArgs } from '../runner/runner-args.js';
import type { RunnerDependencies } from '../runner/runner-dependencies.js';
import { runCodex } from '../runner/runner-codex.js';
import { runnerLogger } from '../runner/runner-logger.js';
import { resultsDir } from '../runner/runner-paths.js';
import { writeJsonAtomic } from '../state/atomic-write.js';
import {
  ensureIncidentIssues,
  incidentRecurrenceRemediation,
  linkIncidentPullRequests,
  recurrenceRemediationResult,
  type IncidentIssue,
  type IncidentRepositoryCheckout,
  type IncidentTicket,
} from './incident-issues.js';
import { selectIncidentRepositories } from './repository-selection.js';

export type IncidentProcessingConfig = RemediationRunConfig &
  Pick<RunnerConfig, 'diagnosisVectors'>;

export interface IncidentInput {
  incidentId: string;
  title?: string;
  status?: string;
  severity?: string;
  fingerprint?: string;
  startedAt?: string;
  updatedAt?: string;
  receivedAt?: string;
  annotations?: { description?: string } | null;
  labels?: { team?: string; service?: string } | null;
}

interface IncidentRepositoryCandidates {
  repositories: IncidentRepositoryCheckout[];
  service_map: string;
}

type ProcessedIncidentTicket = IncidentTicket & {
  [key: string]: unknown;
  vectors: string[];
  updated_at: string | undefined;
};

export async function processIncident(
  config: IncidentProcessingConfig,
  incident: IncidentInput,
  promptTemplate: string,
  args: RunnerArgs,
  dependencies: RunnerDependencies,
  repositorySync: RepositorySyncInfo = { status: 'synced', heads: {} },
): Promise<void> {
  const candidates = await incidentRepositoryContext(config.reposDir);
  const ticket: ProcessedIncidentTicket = {
    id: incident.incidentId,
    custom_id: null,
    name: incident.title,
    description:
      `${incident.annotations?.description || ''}\n\nLabels: ${JSON.stringify(incident.labels || {})}`.trim(),
    url: null,
    status: incident.status,
    task_type: 'incident',
    ticket_type: 'incident',
    area: incident.labels?.team || incident.labels?.service || null,
    vectors: [],
    created_at: incident.startedAt || incident.receivedAt,
    updated_at: incident.updatedAt || incident.receivedAt,
    priority: incident.severity || null,
    tags: ['incident', 'grafana'],
    assignees: [],
    list: null,
    folder: null,
    space: null,
    comments: [],
    attachments: [],
    incident,
    repository_candidates: candidates,
    remediation_mode: args.remediation,
  };
  const ticketDir = ticketResultsDir(resultsDir, ticket.id);
  await mkdir(ticketDir, { recursive: true });
  await writeJsonAtomic(path.join(ticketDir, 'ticket.json'), ticket);
  const result = await runCodex(
    config,
    renderTicketPrompt(promptTemplate, ticket),
    ticketDir,
    [],
  );
  if (result.stdout)
    await writeTextArtifact(
      path.join(ticketDir, 'raw-output.md'),
      result.stdout,
    );
  if (result.stderr)
    await writeStderrArtifact(
      path.join(ticketDir, 'codex-stderr.log'),
      result.stderr,
    );
  if (result.exitCode !== 0)
    throw new Error(
      `Incident diagnosis failed with exit code ${result.exitCode}`,
    );
  const output = extractOutput(result.stdout, config.diagnosisVectors);
  ticket.vectors = [output.vector];
  const selectedRepositories = selectIncidentRepositories(
    output.engineeringAction,
    candidates,
  );
  if (!selectedRepositories.length) {
    output.engineeringAction = {
      ...output.engineeringAction,
      repository_gate: 'UNRESOLVED',
      repository_gate_reason:
        'Nenhum repositório foi confirmado com confiança alta entre os candidatos disponíveis.',
    };
  }
  await writeTextArtifact(
    path.join(ticketDir, 'diagnosis.md'),
    `${output.technicalDiagnosis}\n`,
  );
  await writeTextArtifact(
    path.join(ticketDir, 'cs-comment.md'),
    `${output.csComment}\n`,
  );
  if (output.customerImpact)
    await persistCurrentImpact(ticketDir, {
      ticket_id: ticket.id,
      evaluated_at: new Date().toISOString(),
      ...output.customerImpact,
    });
  await writeJsonAtomic(
    path.join(ticketDir, 'engineering-action.json'),
    output.engineeringAction,
  );
  await writeJsonAtomic(path.join(ticketDir, 'run.json'), {
    ticket_id: ticket.id,
    updated_at: ticket.updated_at,
    started_at: incident.receivedAt,
    finished_at: new Date().toISOString(),
    status: 'diagnosed',
    notification_version: 2,
    notify: args.notify,
    google_chat_space: args.googleChatSpace,
    google_chat_thread: args.googleChatThread,
    remediation_mode: args.remediation,
    remediation_status: 'pending',
    repository_sync: repositorySync,
    classification: output.classification,
    diagnosed_vector: output.vector,
    incident_id: incident.incidentId,
  });
  await writeJsonAtomic(path.join(ticketDir, 'ticket.json'), ticket);
  const issues = await ensureIncidentIssues(
    config,
    ticketDir,
    ticket,
    output,
    dependencies.github,
  );
  if (issues.length) {
    ticket.github_issues = issues;
    await writeJsonAtomic(path.join(ticketDir, 'ticket.json'), ticket);
  }
  if (args.notify) await notifyIncidentDiagnosis(ticket.id);
  const remediation = await remediateIncident(
    config,
    dependencies,
    ticketDir,
    ticket,
    output,
    issues,
    selectedRepositories,
    args,
  );
  await linkIncidentPullRequests(
    config,
    ticket,
    remediation,
    dependencies.github,
  );
  await writeJsonAtomic(path.join(ticketDir, 'remediation.json'), remediation);
  await updateRunArtifact(ticketDir, {
    remediation_status: remediation.status,
    status: 'success',
    finished_at: new Date().toISOString(),
  });
}

export async function resumeIncidentAfterDiagnosis(
  config: IncidentProcessingConfig,
  incidentId: string,
  args: RunnerArgs,
  dependencies: RunnerDependencies,
): Promise<void> {
  const ticketDir = ticketResultsDir(resultsDir, incidentId);
  const ticket = JSON.parse(
    await readFile(path.join(ticketDir, 'ticket.json'), 'utf8'),
  ) as ProcessedIncidentTicket;
  const action = JSON.parse(
    await readFile(path.join(ticketDir, 'engineering-action.json'), 'utf8'),
  ) as DiagnosisOutput['engineeringAction'];
  const run = JSON.parse(
    await readFile(path.join(ticketDir, 'run.json'), 'utf8'),
  ) as Record<string, unknown>;
  let issues: IncidentIssue[] = [];
  let issuesMissing = false;
  try {
    issues = JSON.parse(
      await readFile(path.join(ticketDir, 'github-issues.json'), 'utf8'),
    ) as IncidentIssue[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    issuesMissing = true;
  }
  const output: DiagnosisOutput = {
    classification: String(run.classification || ''),
    vector: String(run.diagnosed_vector || ticket.vectors[0] || ''),
    technicalDiagnosis: await readFile(
      path.join(ticketDir, 'diagnosis.md'),
      'utf8',
    ),
    csComment: await readFile(path.join(ticketDir, 'cs-comment.md'), 'utf8'),
    customerImpact: null,
    engineeringAction: action,
  };
  if (issuesMissing)
    issues = await ensureIncidentIssues(
      config,
      ticketDir,
      ticket,
      output,
      dependencies.github,
    );
  const selectedRepositories = selectIncidentRepositories(
    action,
    ticket.repository_candidates,
  );
  if (args.notify) await notifyIncidentDiagnosis(ticket.id);
  const remediation = await remediateIncident(
    config,
    dependencies,
    ticketDir,
    ticket,
    output,
    issues,
    selectedRepositories,
    args,
  );
  await linkIncidentPullRequests(
    config,
    ticket,
    remediation,
    dependencies.github,
  );
  await writeJsonAtomic(path.join(ticketDir, 'remediation.json'), remediation);
  await updateRunArtifact(ticketDir, {
    remediation_status: remediation.status,
    status: 'success',
    finished_at: new Date().toISOString(),
  });
}

async function remediateIncident(
  config: IncidentProcessingConfig,
  dependencies: RunnerDependencies,
  ticketDir: string,
  ticket: ProcessedIncidentTicket,
  output: DiagnosisOutput,
  issues: IncidentIssue[],
  selected: readonly { name: string }[],
  args: RunnerArgs,
): Promise<RemediationResult> {
  const recurrence =
    args.remediation === 'auto' &&
    shouldRemediate(output.engineeringAction, 'auto')
      ? await incidentRecurrenceRemediation(
          config,
          dependencies.github,
          issues,
          selected,
        )
      : null;
  if (recurrence?.coverage.fullyCovered)
    return recurrenceRemediationResult(
      ticket,
      args.remediation,
      recurrence.openPullRequests,
    );
  const remediation = await runRemediation(
    config,
    ticketDir,
    ticket,
    output.engineeringAction,
    args.remediation,
    {
      recurrence: recurrence?.openPullRequests.length
        ? {
            issues: issues
              .filter((issue) => issue.url)
              .map(({ name, url }) => ({ name, url })),
            open_pull_requests: recurrence.openPullRequests,
          }
        : null,
    },
    dependencies,
  );
  if (
    recurrence?.openPullRequests.length &&
    replacementPullRequests(remediation).length
  ) {
    remediation.superseded_pull_requests = await closeSupersededPullRequests(
      { pull_requests: recurrence.openPullRequests },
      remediation,
      `pela nova ocorrência do incidente ${ticket.id}`,
      dependencies.github,
    );
  }
  return remediation;
}

async function notifyIncidentDiagnosis(incidentId: string): Promise<void> {
  const send = process.send?.bind(process);
  if (!send)
    throw new Error(
      'Incident notifications require the application queue; use --no-notify for CLI diagnostics',
    );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('message', listener);
      reject(new Error('Google Chat notification timed out'));
    }, 120000);
    function listener(message: unknown) {
      if (
        !isIncidentNotificationAck(message) ||
        message.incidentId !== incidentId
      )
        return;
      clearTimeout(timer);
      process.off('message', listener);
      if (message.error) reject(new Error(message.error));
      else resolve();
    }
    process.on('message', listener);
    send({ type: 'incident-diagnosis-ready', incidentId });
  });
}

async function incidentRepositoryContext(
  reposDir: string,
): Promise<IncidentRepositoryCandidates> {
  const repositories = await findGitRepositories(reposDir, [], (message) =>
    runnerLogger.info(message),
  );
  const serviceMapPath = path.join(
    codexHomeDir(reposDir),
    'skills',
    'driva-debug',
    'references',
    'service-map.md',
  );
  let serviceMap = '';
  try {
    serviceMap = await readFile(serviceMapPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    runnerLogger.warn('Service map unavailable: ' + serviceMapPath);
  }
  return {
    repositories: repositories.map((directory) => ({
      name: path.relative(reposDir, directory),
      path: directory,
    })),
    service_map: serviceMap.slice(0, 24000),
  };
}
