import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  shouldRemediate,
  type EngineeringAction,
} from '../diagnosis/diagnosis-output.js';
import type { RemediationMode } from '../diagnosis/diagnosis-run.js';
import {
  incidentRecurrenceCoverage,
  openIncidentPullRequests,
  recurrenceRemediationResult,
  type IncidentPullRequest,
} from '../incidents/incident-issues.js';
import { incidentActionRepositories } from '../incidents/repository-selection.js';
import { replacementPullRequests } from './remediation-reorientation.js';
import {
  closeSupersededPullRequests,
  runRemediation,
  type RemediationResult,
  type RemediationRunConfig,
  type RemediationTicket,
} from './remediation-run.js';
import type { RunnerDependencies } from '../runner/runner-dependencies.js';

export function previousTicketPullRequests(
  previousRemediation: unknown,
): IncidentPullRequest[] {
  if (typeof previousRemediation !== 'object' || previousRemediation === null)
    return [];
  const record = previousRemediation as Record<string, unknown>;
  const list = Array.isArray(record.supersedable_pull_requests)
    ? record.supersedable_pull_requests
    : record.pull_requests;
  if (!Array.isArray(list)) return [];
  const pullRequests: IncidentPullRequest[] = [];
  for (const entry of list as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { url, repository } = entry as Record<string, unknown>;
    if (typeof url !== 'string' || !url.trim()) continue;
    if (pullRequests.some((pullRequest) => pullRequest.url === url)) continue;
    pullRequests.push({ url, repository });
  }
  return pullRequests;
}

export function ticketReuseRemediationResult(
  ticket: RemediationTicket,
  mode: RemediationMode,
  openPullRequests: readonly IncidentPullRequest[],
): RemediationResult {
  return {
    ...recurrenceRemediationResult(ticket, mode, openPullRequests),
    summary:
      'Novo diagnóstico do ticket: os PRs de remediação já abertos foram mantidos e nenhum PR novo foi criado.',
    reason: `Todos os repositórios da ação já possuem PR aberto para este ticket: ${openPullRequests.map((pullRequest) => pullRequest.url).join(', ')}`,
  };
}

async function readPreviousRemediation(ticketDir: string): Promise<unknown> {
  try {
    return JSON.parse(
      await readFile(path.join(ticketDir, 'remediation.json'), 'utf8'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function remediateTicket(
  config: RemediationRunConfig,
  ticketDir: string,
  ticket: RemediationTicket,
  action: EngineeringAction,
  mode: RemediationMode,
  dependencies: RunnerDependencies,
): Promise<RemediationResult> {
  const previousPullRequests =
    mode === 'auto' && shouldRemediate(action, 'auto')
      ? previousTicketPullRequests(await readPreviousRemediation(ticketDir))
      : [];
  const openPullRequests = previousPullRequests.length
    ? await openIncidentPullRequests(
        config,
        dependencies.github,
        previousPullRequests,
      )
    : [];
  if (
    incidentRecurrenceCoverage(
      incidentActionRepositories(action),
      openPullRequests,
    ).fullyCovered
  )
    return ticketReuseRemediationResult(ticket, mode, openPullRequests);
  const remediation = await runRemediation(
    config,
    ticketDir,
    ticket,
    action,
    mode,
    {
      recurrence: openPullRequests.length
        ? { open_pull_requests: openPullRequests }
        : null,
    },
    dependencies,
  );
  if (openPullRequests.length && replacementPullRequests(remediation).length) {
    remediation.superseded_pull_requests = await closeSupersededPullRequests(
      { pull_requests: openPullRequests },
      remediation,
      `pelo novo diagnóstico do ticket ${ticket.id}`,
      dependencies.github,
    );
  }
  return remediation;
}
