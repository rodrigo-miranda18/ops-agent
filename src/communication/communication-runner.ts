#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  downloadClickUpAttachment,
  fetchTask,
} from '../clickup/clickup-api.js';
import { CODEX_COMMUNICATION_PERMISSIONS } from '../codex/codex.js';
import { runAgentExec } from '../agent/agent-exec.js';
import { sanitize } from '../common/sanitize.js';
import {
  communicationCodexEnvironment,
  communicationConfigFromEnv,
} from '../config/communication-config.js';
import { loadDotEnv } from '../config/env.js';
import { runnerConfigFromEnv } from '../config/runner-config.js';
import { findGitRepositories, runGit } from '../git/git.js';
import { withRepositoryAccess } from '../git/repository-access.js';
import type { GitHubExecutor } from '../github/gh.js';
import { createScopedInstallationToken } from '../github/github-credentials.js';
import { githubSlug } from '../incidents/repository-selection.js';
import { createRunnerDependencies } from '../runner/runner-dependencies.js';
import { runnerLogger } from '../runner/runner-logger.js';
import { projectDir, stateDir } from '../runner/runner-paths.js';
import { createInstanceId } from '../state/owner-identity.js';
import { releaseAllOwnedLocks } from '../state/owned-lock.js';
import {
  buildCommunicationHistory,
  parseCommunicationArgs,
} from './communication-args.js';
import { collectClickUpContext } from './clickup-context.js';
import { createMediaStorage } from './media-storage.js';
import { runCommunication } from './communication-run.js';
import {
  COMMUNICATION_STATE_FILE,
  findCommunication,
  type CommunicationRecord,
  type CommunicationRecords,
} from './communication-store.js';
import {
  DRIVA_GITHUB_ORGANIZATION,
  sanitizePullRequestView,
  type PullRequestRef,
} from './pull-request-links.js';
import type { CommunicationRunnerMessage } from './runner-messages.js';

const MAX_DIFF_BYTES = 60 * 1024;

type RunnerConfig = ReturnType<typeof runnerConfigFromEnv>;

async function readRecord(communicationId: string) {
  let records: unknown;
  try {
    records = JSON.parse(
      await readFile(path.join(stateDir, COMMUNICATION_STATE_FILE), 'utf8'),
    ) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    records = {};
  }
  if (typeof records !== 'object' || records === null || Array.isArray(records))
    throw new Error(`${COMMUNICATION_STATE_FILE} must be an object`);
  const record = findCommunication(
    records as CommunicationRecords,
    communicationId,
  );
  if (!record) throw new Error(`Communication not found: ${communicationId}`);
  return record;
}

async function readOptionalJson(filename: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filename, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function previousOutputs(record: CommunicationRecord, version: number) {
  const outputs = new Map<number, unknown>();
  for (const item of record.versions) {
    if (item.number >= version) continue;
    outputs.set(
      item.number,
      await readOptionalJson(path.join(item.artifactDir, 'output.json')),
    );
  }
  return outputs;
}

async function resolveTeamId(
  config: { token: string },
  record: CommunicationRecord,
): Promise<string> {
  if (record.task.teamId) return record.task.teamId;
  const task = await fetchTask(config, record.task.id);
  const teamId = task.team_id;
  if (typeof teamId !== 'string' && typeof teamId !== 'number')
    throw new Error(`ClickUp task ${record.task.id} has no team_id`);
  return String(teamId);
}

async function suiteRepositories(
  config: RunnerConfig,
  organization: string,
): Promise<string[]> {
  const repositories = await findGitRepositories(
    config.reposDir,
    config.repositorySyncIgnore,
    () => undefined,
  );
  const names = new Set<string>();
  for (const repository of repositories) {
    const slug = githubSlug(
      await runGit(config, repository, ['remote', 'get-url', 'origin']),
    );
    const [owner, name] = slug?.split('/') ?? [];
    if (owner?.toLowerCase() === organization.toLowerCase() && name)
      names.add(name);
  }
  return [...names].sort();
}

async function readPullRequest(github: GitHubExecutor, ref: PullRequestRef) {
  const view = JSON.parse(
    await github([
      'pr',
      'view',
      ref.url,
      '--json',
      'title,body,state,mergedAt,files',
    ]),
  ) as unknown;
  const diff = Buffer.from(await github(['pr', 'diff', ref.url]));
  return {
    url: ref.url,
    view: sanitizePullRequestView(view),
    diff: sanitize(diff.subarray(0, MAX_DIFF_BYTES).toString('utf8')),
    diffTruncated: diff.length > MAX_DIFF_BYTES,
  };
}

function send(message: CommunicationRunnerMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(message, undefined, undefined, () => resolve());
  });
}

function printHelp() {
  runnerLogger.info(
    'Usage: npm run communication -- --communication-id=<id> --version=<n>',
  );
}

async function main(): Promise<void> {
  await loadDotEnv(path.join(projectDir, '.env'));
  const args = parseCommunicationArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const { communicationId, version } = args;
  try {
    const config = runnerConfigFromEnv({});
    const communication = communicationConfigFromEnv();
    const clickUpToken = config.token;
    if (!clickUpToken) throw new Error('CLICKUP_API_TOKEN is required');
    const clickUp = {
      token: clickUpToken,
      maxAttachmentBytes: config.maxAttachmentBytes,
    };
    const record = await readRecord(communicationId);
    const entry = record.versions.find((item) => item.number === version);
    if (!entry) throw new Error(`Communication version not found: v${version}`);
    const history = buildCommunicationHistory(
      record,
      version,
      await previousOutputs(record, version),
    );
    const teamId = await resolveTeamId(clickUp, record);
    const { github } = createRunnerDependencies(config);
    const timestamp = new Date().toISOString();
    const owner = {
      instanceId: createInstanceId('runner'),
      pid: process.pid,
      startedAt: timestamp,
      heartbeatAt: timestamp,
    };
    runnerLogger.info(
      `Communication ${communicationId} v${version}: generating for task ${record.task.id}`,
    );
    const output = await withRepositoryAccess(config, { stateDir, owner }, () =>
      runCommunication(
        {
          communicationId,
          version,
          taskId: record.task.id,
          history,
          artifactDir: entry.artifactDir,
          reposDir: config.reposDir,
          organization:
            config.github.mode === 'app'
              ? config.github.organization
              : DRIVA_GITHUB_ORGANIZATION,
        },
        {
          collect: (taskId) =>
            collectClickUpContext(
              {
                token: clickUpToken,
                teamId,
                maxImages: communication.maxImages,
              },
              taskId,
            ),
          readPullRequest: (ref) => readPullRequest(github, ref),
          scopedToken: async () => {
            const githubConfig = config.github;
            if (githubConfig.mode !== 'app')
              throw new Error('Scoped tokens require GitHub App auth');
            const repositories = await suiteRepositories(
              config,
              githubConfig.organization,
            );
            if (!repositories.length)
              throw new Error('No suite repositories found');
            const { token } = await createScopedInstallationToken(
              githubConfig,
              {
                repositories,
                permissions: { contents: 'read', pull_requests: 'read' },
              },
            );
            return token;
          },
          media: communication.media
            ? createMediaStorage(communication.media)
            : null,
          downloadImage: (url, destination) =>
            downloadClickUpAttachment(clickUp, url, destination),
          runCodex: async (input) => {
            const result = await runAgentExec({
              surface: 'communication',
              profile: 'communication',
              agent: config.agent,
              codexBin: config.codexBin,
              cwd: input.cwd,
              env: {
                ...communicationCodexEnvironment(),
                ...(input.ghToken ? { GH_TOKEN: input.ghToken } : {}),
              },
              timeoutMs: communication.attemptTimeoutMs,
              prompt: input.prompt,
              addDir: entry.artifactDir,
              permissions: CODEX_COMMUNICATION_PERMISSIONS,
              model: communication.codexModel,
              imagePaths: input.imagePaths,
            });
            return {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            };
          },
        },
      ),
    );
    runnerLogger.info(
      `Communication ${communicationId} v${version}: ${output.status}`,
    );
    await send({ type: 'communication-ready', communicationId, version });
  } catch (error) {
    const message = sanitize((error as Error).message).slice(-2000);
    runnerLogger.error(
      `Communication ${communicationId} v${version} failed: ${message}`,
    );
    await send({
      type: 'communication-failed',
      communicationId,
      version,
      error: message,
    });
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.once('SIGTERM', () => {
    void releaseAllOwnedLocks().finally(() => process.exit(143));
  });
  main().catch((error: Error) => {
    runnerLogger.error(
      `Communication runner failed: ${sanitize(error.message)}`,
    );
    process.exitCode = 1;
  });
}
