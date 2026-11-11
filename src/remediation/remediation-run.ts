import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitize } from '../common/sanitize.js';
import type { CodexExecResult } from '../codex/codex.js';
import type { RunnerConfig } from '../config/runner-config.js';
import {
  removeIfExists,
  writeStderrArtifact,
  writeTextArtifact,
} from '../diagnosis/diagnosis-artifacts.js';
import {
  shouldRemediate,
  type EngineeringAction,
} from '../diagnosis/diagnosis-output.js';
import type { RemediationMode } from '../diagnosis/diagnosis-run.js';
import {
  prepareRemediationWorktreesDir,
  removeWorktreesDir,
} from '../git/worktrees.js';
import type { GitHubExecutor } from '../github/gh.js';
import { runCodex, type RunnerCodexConfig } from '../runner/runner-codex.js';
import type { RunnerDependencies } from '../runner/runner-dependencies.js';
import { runnerDir } from '../runner/runner-paths.js';
import { writeJsonAtomic } from '../state/atomic-write.js';
import { renderRemediationPrompt } from './remediation-prompt.js';
import {
  replacementPullRequests,
  selectSupersededPullRequests,
  type RemediationPullRequest,
  type RemediationPullRequests,
} from './remediation-reorientation.js';

export const REMEDIATION_STATUSES = [
  'PR_OPENED',
  'MULTIPLE_PRS_OPENED',
  'ALREADY_FIXED',
  'PLAN_ONLY',
  'IMPLEMENTATION_FAILED',
  'BLOCKED_BY_EVIDENCE',
] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];

function isRemediationStatus(value: unknown): value is RemediationStatus {
  return (REMEDIATION_STATUSES as readonly unknown[]).includes(value);
}

const REMEDIATION_RESULT_PATTERN =
  /<!--\s*REMEDIATION_RESULT_START\s*-->([\s\S]*?)<!--\s*REMEDIATION_RESULT_END\s*-->/i;

export type RemediationResult = Record<string, unknown> & { status: unknown };

export type RemediationRunConfig = RunnerCodexConfig &
  Pick<RunnerConfig, 'remediationTimeoutMs' | 'repositorySyncTimeoutMs'>;

export interface RemediationTicket {
  id: string;
}

export interface RemediationContext {
  force?: boolean;
  instruction?: string;
  previousRemediation?: unknown;
  recurrence?: unknown;
  branchKey?: string;
}

export function remediationBranchName(
  ticket: RemediationTicket,
  action: EngineeringAction,
  context: RemediationContext = {},
) {
  const safeTicket = ticket.id.replace(/[^A-Za-z0-9_-]/g, '-');
  const cause = JSON.stringify({
    action,
    instruction: context.instruction,
    branchKey: context.branchKey,
  });
  const hash = createHash('sha256').update(cause).digest('hex').slice(0, 10);
  return `fix/driva-ops-${safeTicket}-${hash}`;
}

export interface SupersededPullRequestResult {
  repository: unknown;
  url: string;
  status: 'failed' | 'merged' | 'already_closed' | 'closed';
  reason?: string;
}

export async function runRemediation(
  config: RemediationRunConfig,
  ticketDir: string,
  ticket: RemediationTicket,
  action: EngineeringAction,
  mode: RemediationMode,
  context: RemediationContext,
  dependencies: RunnerDependencies,
): Promise<RemediationResult> {
  const startedAt = new Date().toISOString();
  const stderrPath = path.join(ticketDir, 'remediation-stderr.log');
  const remediationPath = path.join(ticketDir, 'remediation.json');
  if (!context.force && !shouldRemediate(action, mode)) {
    const result = {
      ticket_id: ticket.id,
      mode,
      status: 'PLAN_ONLY',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      summary:
        mode === 'none'
          ? 'Remediação desativada para esta execução.'
          : 'Nenhuma implementação elegível foi iniciada.',
      reason: [action.repository_gate_reason, action.reason]
        .filter(Boolean)
        .join(' '),
      repositories: [],
      checks: [],
      pull_requests: [],
    };
    await writeJsonAtomic(remediationPath, result);
    await removeIfExists(stderrPath);
    return result;
  }

  if (mode === 'auto') {
    try {
      await dependencies.ensureGitHubAccess(
        action.repositories.map((repository) => repository.name),
      );
    } catch (error) {
      const failure = {
        ticket_id: ticket.id,
        mode,
        status: 'IMPLEMENTATION_FAILED',
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        summary: 'Não foi possível validar o acesso ao GitHub.',
        reason: sanitize((error as Error).message),
        repositories: [],
        checks: [],
        pull_requests: [],
      };
      await writeJsonAtomic(remediationPath, failure);
      await writeTextArtifact(stderrPath, `${failure.reason}\n`);
      return failure;
    }
  }

  const promptTemplate = await readFile(
    path.join(runnerDir, 'prompts', 'remediation-prompt.md'),
    'utf8',
  );
  const worktreesDir = await prepareRemediationWorktreesDir(config, ticket.id);
  const prompt = renderRemediationPrompt(promptTemplate, {
    mode,
    worktreesDir,
    branchName: remediationBranchName(ticket, action, context),
    ticket,
    action,
    instruction: context.instruction,
    previousRemediation: context.previousRemediation,
    recurrence: context.recurrence,
  });
  let result: CodexExecResult;
  try {
    result = await runCodex(config, prompt, ticketDir, [], {
      remediation: mode === 'auto',
      timeoutMs: config.remediationTimeoutMs,
    });
  } catch (error) {
    const failure = {
      ticket_id: ticket.id,
      mode,
      status: 'IMPLEMENTATION_FAILED',
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      summary: 'Não foi possível iniciar o subagente de remediação.',
      reason: sanitize((error as Error).message),
      repositories: [],
      checks: [],
      pull_requests: [],
    };
    await writeJsonAtomic(remediationPath, failure);
    await writeTextArtifact(stderrPath, `${failure.reason}\n`);
    await removeWorktreesDir(worktreesDir);
    return failure;
  }
  await removeWorktreesDir(worktreesDir);
  if (result.stderr) await writeStderrArtifact(stderrPath, result.stderr);
  else await removeIfExists(stderrPath);
  let parsed: RemediationResult;
  try {
    parsed = parseRemediationOutput(result);
  } catch (error) {
    parsed = {
      status: 'IMPLEMENTATION_FAILED',
      summary: 'A execução não retornou um resultado estruturado válido.',
      reason: sanitize((error as Error).message),
      repositories: [],
      checks: [],
      pull_requests: [],
    };
  }
  const remediation: RemediationResult = {
    ticket_id: ticket.id,
    mode,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ...parsed,
  };
  if (
    result.exitCode !== 0 &&
    !['IMPLEMENTATION_FAILED', 'BLOCKED_BY_EVIDENCE'].includes(
      remediation.status as string,
    )
  )
    remediation.status = 'IMPLEMENTATION_FAILED';
  await writeJsonAtomic(remediationPath, remediation);
  return remediation;
}

function parseRemediationOutput(result: CodexExecResult): RemediationResult {
  const match = result.stdout.match(REMEDIATION_RESULT_PATTERN);
  if (!match) {
    const detail = result.stderr
      ? `: ${result.stderr.trim().split('\n').slice(-1)[0]}`
      : '';
    throw new Error(`Remediation output marker was not found${detail}`);
  }
  const remediation = JSON.parse(
    match[1].trim().replace(/^```json\s*|\s*```$/g, ''),
  ) as RemediationResult;
  if (!isRemediationStatus(remediation.status))
    throw new Error('Invalid remediation status');
  return remediation;
}

export async function closeSupersededPullRequests(
  previousRemediation: RemediationPullRequests,
  remediation: RemediationPullRequests,
  reason: string,
  github: GitHubExecutor,
): Promise<SupersededPullRequestResult[]> {
  const superseded = selectSupersededPullRequests(
    previousRemediation,
    remediation,
  ) as RemediationPullRequest[];
  const replacementUrls = replacementPullRequests(remediation)
    .map(({ url }) => url)
    .join(', ');
  const results: SupersededPullRequestResult[] = [];
  for (const pullRequest of superseded) {
    const entry: SupersededPullRequestResult = {
      repository: pullRequest.repository,
      url: pullRequest.url,
      status: 'failed',
    };
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
      if (state === 'MERGED') entry.status = 'merged';
      else if (state === 'CLOSED') entry.status = 'already_closed';
      else if (state === 'OPEN') {
        const comment = `Fechado pelo Driva Ops Agent: substituído ${reason}. Novos PRs: ${replacementUrls}`;
        await github(['pr', 'close', pullRequest.url, '--comment', comment]);
        entry.status = 'closed';
      } else {
        entry.reason = `Estado inesperado retornado pelo GitHub: ${state || 'vazio'}`;
      }
    } catch (error) {
      entry.reason = sanitize((error as Error).message).slice(0, 1000);
    }
    results.push(entry);
  }
  return results;
}
