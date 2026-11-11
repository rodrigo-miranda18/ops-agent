import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitize } from '../common/sanitize.js';
import { runGit } from '../git/git.js';
import type { GitHubExecutor } from '../github/gh.js';
import { pullRequestRepository } from '../remediation/remediation-reorientation.js';
import { runnerLogger, type RunnerLogger } from '../runner/runner-logger.js';
import { writeJsonAtomic } from '../state/atomic-write.js';
import {
  githubSlug,
  selectIncidentRepositories,
  type IncidentRepositoryAction,
  type IncidentRepositoryContext,
} from './repository-selection.js';
import {
  incidentPullRequestLinkComment,
  linkedIncidentPullRequestUrls,
} from './incident-pull-request-links.js';

export interface IncidentGitHubConfig {
  reposDir: string;
  repositorySyncTimeoutMs: number;
}

export type IncidentGitHub = GitHubExecutor;

export interface IncidentIssue {
  repository: string;
  name: string;
  role?: string | null;
  scope?: string | null;
  url?: string;
  reused?: boolean;
  createdAt?: string;
  siblingsLinked?: boolean;
  siblingsLinkError?: string;
  recurrenceCommented?: boolean;
  recurrenceCommentError?: string;
}

export interface IncidentRepositoryCheckout {
  name: string;
  path: string;
}

export interface IncidentTicket {
  id: string;
  name?: string;
  created_at?: unknown;
  remediation_mode?: unknown;
  incident?: {
    fingerprint?: string;
    severity?: string;
    startedAt?: string;
  } | null;
  repository_candidates?: IncidentRepositoryContext<IncidentRepositoryCheckout>;
  github_issues?: IncidentIssue[];
}

export interface IncidentDiagnosisOutput {
  vector: string;
  technicalDiagnosis: string;
  engineeringAction: IncidentRepositoryAction;
}

export interface IncidentPullRequest {
  url: string;
  repository: unknown;
}

export interface IncidentRemediation {
  [key: string]: unknown;
  recurrence_reused?: boolean;
  pull_requests?: { url?: string; repository?: unknown }[];
  github_issue_link_error?: string;
  github_issues_linked?: string[];
  github_issue_unlinked_pull_requests?: string[];
}

export interface IncidentRecurrenceCoverage {
  covered: string[];
  uncovered: string[];
  fullyCovered: boolean;
}

export interface IncidentRecurrence {
  openPullRequests: IncidentPullRequest[];
  coverage: IncidentRecurrenceCoverage;
}

function errorMessage(error: unknown): string {
  return sanitize((error as Error).message).slice(0, 1000);
}

export async function linkIncidentPullRequests(
  config: IncidentGitHubConfig,
  ticket: IncidentTicket,
  remediation: IncidentRemediation | null | undefined,
  github: IncidentGitHub,
  logger: RunnerLogger = runnerLogger,
): Promise<void> {
  if (remediation?.recurrence_reused) return;
  const issues = (ticket.github_issues || []).filter((issue) => issue.url);
  const prs = remediation?.pull_requests?.filter((pr) => pr.url) || [];
  if (!remediation || !issues.length || !prs.length) return;
  const linked: string[] = [];
  for (const issue of issues) {
    const target =
      issues.length === 1
        ? prs
        : prs.filter((pr) => matchesIncidentRepository(pr.repository, issue));
    if (!target.length) continue;
    try {
      await github([
        'issue',
        'comment',
        String(issue.url),
        '--body',
        incidentPullRequestLinkComment(target.map((pr) => String(pr.url))),
      ]);
      linked.push(String(issue.url));
    } catch (error) {
      remediation.github_issue_link_error = errorMessage(error);
      logger.warn(
        `Could not link remediation PRs to incident issue ${issue.url}: ${remediation.github_issue_link_error}`,
      );
    }
  }
  remediation.github_issues_linked = linked;
  const unmatched =
    issues.length > 1
      ? prs.filter(
          (pr) =>
            !issues.some((issue) =>
              matchesIncidentRepository(pr.repository, issue),
            ),
        )
      : [];
  if (unmatched.length) {
    remediation.github_issue_unlinked_pull_requests = unmatched.map((pr) =>
      String(pr.url),
    );
  }
}

function matchesIncidentRepository(
  value: unknown,
  issue: IncidentIssue,
): boolean {
  const name = String(value || '').trim();
  return (
    Boolean(name) &&
    (name === issue.name ||
      name === issue.repository ||
      name === issue.repository?.split('/')[1])
  );
}

export async function incidentRecurrenceRemediation(
  config: IncidentGitHubConfig,
  github: IncidentGitHub,
  issues: readonly IncidentIssue[],
  selected: readonly { name: string }[],
): Promise<IncidentRecurrence | null> {
  if (!selected.length || !issues.some((issue) => issue.reused && issue.url)) {
    return null;
  }
  const linked = await linkedIncidentPullRequests(config, github, issues);
  const openPullRequests = await openIncidentPullRequests(
    config,
    github,
    linked,
  );
  return {
    openPullRequests,
    coverage: incidentRecurrenceCoverage(selected, openPullRequests),
  };
}

function issueComments(detail: unknown): unknown[] {
  const comments =
    typeof detail === 'object' && detail !== null && 'comments' in detail
      ? detail.comments
      : undefined;
  return Array.isArray(comments) ? comments : [];
}

export async function linkedIncidentPullRequests(
  config: IncidentGitHubConfig,
  github: IncidentGitHub,
  issues: readonly IncidentIssue[],
  logger: RunnerLogger = runnerLogger,
): Promise<IncidentPullRequest[]> {
  const pullRequests: IncidentPullRequest[] = [];
  for (const issue of issues) {
    if (!issue.reused || !issue.url) continue;
    try {
      const detail: unknown = JSON.parse(
        await github(['issue', 'view', issue.url, '--json', 'comments']),
      );
      const bodies = issueComments(detail).map((comment) =>
        typeof comment === 'object' &&
        comment !== null &&
        'body' in comment &&
        typeof comment.body === 'string'
          ? comment.body
          : '',
      );
      for (const url of linkedIncidentPullRequestUrls(bodies)) {
        if (!pullRequests.some((pullRequest) => pullRequest.url === url))
          pullRequests.push({
            url,
            repository: pullRequestRepository({ url }),
          });
      }
    } catch (error) {
      logger.warn(
        `Could not read comments of incident issue ${issue.url}: ${errorMessage(error)}`,
      );
    }
  }
  return pullRequests;
}

export async function openIncidentPullRequests<T extends { url: string }>(
  config: IncidentGitHubConfig,
  github: IncidentGitHub,
  pullRequests: readonly T[],
  logger: RunnerLogger = runnerLogger,
): Promise<T[]> {
  const open: T[] = [];
  for (const pullRequest of pullRequests) {
    try {
      const state = (
        await github([
          'pr',
          'view',
          pullRequest.url,
          '--json',
          'state',
          '--jq',
          '.state',
        ])
      )
        .trim()
        .toUpperCase();
      if (state === 'OPEN') open.push(pullRequest);
    } catch (error) {
      logger.warn(
        `Could not inspect incident pull request ${pullRequest.url}: ${errorMessage(error)}`,
      );
    }
  }
  return open;
}

export function incidentRecurrenceCoverage(
  selected: readonly { name: string }[],
  openPullRequests: readonly unknown[],
): IncidentRecurrenceCoverage {
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const entry of selected) {
    const isCovered = openPullRequests.some((pullRequest) =>
      sameIncidentRepository(pullRequestRepository(pullRequest), entry.name),
    );
    (isCovered ? covered : uncovered).push(entry.name);
  }
  return {
    covered,
    uncovered,
    fullyCovered: Boolean(selected.length) && uncovered.length === 0,
  };
}

function sameIncidentRepository(left: unknown, right: unknown): boolean {
  const a = String(left || '')
    .trim()
    .toLocaleLowerCase('en-US');
  const b = String(right || '')
    .trim()
    .toLocaleLowerCase('en-US');
  if (!a || !b) return false;
  const lastSegment = (value: string) => value.split('/').filter(Boolean).pop();
  return a === b || lastSegment(a) === lastSegment(b);
}

export function recurrenceRemediationResult(
  ticket: Pick<IncidentTicket, 'id'>,
  mode: unknown,
  openPullRequests: readonly IncidentPullRequest[],
) {
  const finishedAt = new Date().toISOString();
  return {
    ticket_id: ticket.id,
    mode,
    status: openPullRequests.length > 1 ? 'MULTIPLE_PRS_OPENED' : 'PR_OPENED',
    started_at: finishedAt,
    finished_at: finishedAt,
    summary:
      'Ocorrência repetida do incidente: os PRs de remediação já abertos foram mantidos e nenhum PR novo foi criado.',
    reason: `Todos os repositórios selecionados já possuem PR aberto para este incidente: ${openPullRequests.map((pullRequest) => pullRequest.url).join(', ')}`,
    repositories: [],
    checks: [],
    pull_requests: openPullRequests.map(({ repository, url }) => ({
      repository,
      url,
      depends_on: [],
    })),
    recurrence_reused: true,
  };
}

async function readIncidentIssues(statePath: string): Promise<IncidentIssue[]> {
  try {
    return JSON.parse(await readFile(statePath, 'utf8')) as IncidentIssue[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
}

export async function ensureIncidentIssues(
  config: IncidentGitHubConfig,
  ticketDir: string,
  ticket: IncidentTicket,
  output: IncidentDiagnosisOutput,
  github: IncidentGitHub,
  logger: RunnerLogger = runnerLogger,
): Promise<IncidentIssue[]> {
  const statePath = path.join(ticketDir, 'github-issues.json');
  let issues = await readIncidentIssues(statePath);
  const selected = selectIncidentRepositories(
    output.engineeringAction,
    ticket.repository_candidates,
  );
  if (!selected.length || argsModeIsReadOnly(ticket)) return issues;
  const { key, marker } = incidentIssueIdentity(ticket);
  for (const entry of selected) {
    if (issues.some((issue) => issue.name === entry.name)) continue;
    const remote = await runGit(config, entry.path, [
      'remote',
      'get-url',
      'origin',
    ]);
    const repo = githubSlug(remote);
    if (!repo) {
      throw new Error('Selected repository has no supported GitHub origin');
    }
    const matches = JSON.parse(
      await github([
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--search',
        `${key} in:body`,
        '--limit',
        '100',
        '--json',
        'url,body',
      ]),
    ) as { url?: string; body?: unknown }[];
    const existing = matches.find(
      (item) => typeof item.body === 'string' && item.body.includes(marker),
    );
    const issue: IncidentIssue = {
      repository: repo,
      name: entry.name,
      role: entry.role,
      scope: entry.scope,
      url: existing?.url,
      reused: Boolean(existing),
      createdAt: new Date().toISOString(),
    };
    if (existing) {
      await commentIncidentRecurrence(
        config,
        github,
        issue,
        ticket,
        output,
        logger,
      );
    } else {
      const bodyPath = path.join(
        ticketDir,
        `github-issue-body-${entry.name.replace(/[^A-Za-z0-9_-]/g, '_')}.md`,
      );
      await writeFile(
        bodyPath,
        `${marker}\n${incidentIssueBody(ticket, output, entry, selected)}`,
        { mode: 0o600 },
      );
      issue.url = await github([
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        `[incident] ${ticket.name}`,
        '--body-file',
        bodyPath,
      ]);
    }
    issues = [...issues, issue];
    await writeJsonAtomic(statePath, issues);
  }
  if (await crossLinkIncidentIssues(config, github, issues, logger)) {
    await writeJsonAtomic(statePath, issues);
  }
  return issues;
}

function incidentIssueBody(
  ticket: IncidentTicket,
  output: IncidentDiagnosisOutput,
  entry: { name: string; role: string | null; scope: string | null },
  selected: readonly {
    name: string;
    role: string | null;
    scope: string | null;
  }[],
): string {
  const siblings = selected
    .filter((item) => item.name !== entry.name)
    .map(
      (item) =>
        `- ${item.name}${item.role ? ` (${item.role})` : ''}${item.scope ? `: ${item.scope}` : ''}`,
    );
  return [
    `## Incidente Grafana`,
    `- Incidente: ${ticket.id}`,
    `- Severidade: ${ticket.incident?.severity || 'não informada'}`,
    `- Vetor: ${output.vector}`,
    `- Fingerprint: ${ticket.incident?.fingerprint || 'n/a'}`,
    `- Papel deste repositório: ${entry.role || 'não informado'}`,
    '',
    '### Escopo neste repositório',
    entry.scope ||
      'O diagnóstico não delimitou um escopo específico para este repositório.',
    '',
    ...(siblings.length
      ? ['### Outros repositórios afetados', ...siblings, '']
      : []),
    '### Diagnóstico',
    output.technicalDiagnosis,
    '',
    '### Ação técnica',
    JSON.stringify(output.engineeringAction, null, 2),
  ].join('\n');
}

async function crossLinkIncidentIssues(
  config: IncidentGitHubConfig,
  github: IncidentGitHub,
  issues: readonly IncidentIssue[],
  logger: RunnerLogger,
): Promise<boolean> {
  const linkable = issues.filter((issue) => issue.url);
  if (linkable.length < 2) return false;
  let changed = false;
  for (const issue of linkable.filter(
    (item) => !item.reused && !item.siblingsLinked && !item.siblingsLinkError,
  )) {
    const siblings = linkable
      .filter((item) => item.url !== issue.url)
      .map((item) => `- ${item.repository}: ${item.url}`)
      .join('\n');
    try {
      await github([
        'issue',
        'comment',
        String(issue.url),
        '--body',
        `Este incidente também abriu registro nos repositórios abaixo:\n${siblings}`,
      ]);
      issue.siblingsLinked = true;
    } catch (error) {
      issue.siblingsLinkError = errorMessage(error);
      logger.warn(
        `Could not cross-link incident issue ${issue.url}: ${issue.siblingsLinkError}`,
      );
    }
    changed = true;
  }
  return changed;
}

export function incidentIssueIdentity(
  ticket: Pick<IncidentTicket, 'id' | 'incident'>,
): { key: string; marker: string } {
  const fingerprint = ticket.incident?.fingerprint;
  return fingerprint
    ? {
        key: fingerprint,
        marker: `<!-- incident-fingerprint:${fingerprint} -->`,
      }
    : { key: ticket.id, marker: `<!-- incident:${ticket.id} -->` };
}

export function incidentRecurrenceCommentBody(input: {
  incidentId: string;
  startedAt?: unknown;
  severity?: string;
  vector?: string;
}): string {
  return [
    'O alerta voltou a disparar e a causa segue sem correção publicada, então nenhuma issue nova foi aberta.',
    `- Incidente: ${input.incidentId}`,
    `- Disparo: ${input.startedAt || 'não informado'}`,
    `- Severidade: ${input.severity || 'não informada'}`,
    `- Vetor: ${input.vector || 'não informado'}`,
  ].join('\n');
}

async function commentIncidentRecurrence(
  config: IncidentGitHubConfig,
  github: IncidentGitHub,
  issue: IncidentIssue,
  ticket: IncidentTicket,
  output: IncidentDiagnosisOutput,
  logger: RunnerLogger,
): Promise<void> {
  const body = incidentRecurrenceCommentBody({
    incidentId: ticket.id,
    startedAt: ticket.incident?.startedAt || ticket.created_at,
    severity: ticket.incident?.severity,
    vector: output.vector,
  });
  try {
    await github(['issue', 'comment', String(issue.url), '--body', body]);
    issue.recurrenceCommented = true;
  } catch (error) {
    issue.recurrenceCommentError = errorMessage(error);
    logger.warn(
      `Could not comment incident recurrence on ${issue.url}: ${issue.recurrenceCommentError}`,
    );
  }
}

function argsModeIsReadOnly(ticket: IncidentTicket): boolean {
  return ticket.remediation_mode !== 'auto';
}
