import { runAgentExec } from '../agent/agent-exec.js';
import { sanitize } from '../common/sanitize.js';
import {
  CODEX_READ_NETWORK_PERMISSIONS,
  codexSandboxPermissions,
  type CodexExecResult,
} from '../codex/codex.js';
import {
  codexEnvironment,
  GITHUB_HELPER_ENVIRONMENT,
  pickEnv,
  processEnv,
  type Environment,
} from '../config/env.js';
import type { RunnerConfig } from '../config/runner-config.js';
import { goDependencyEnvironment } from '../git/go-environment.js';
import { dependencyCacheDir } from './runner-paths.js';

export type RunnerCodexConfig = Pick<
  RunnerConfig,
  'codexBin' | 'reposDir' | 'codexTimeoutMs' | 'codexModel'
> &
  Partial<Pick<RunnerConfig, 'agent'>>;

export interface RunCodexOptions {
  remediation?: boolean;
  timeoutMs?: number;
}

export async function runCodex(
  config: RunnerCodexConfig,
  prompt: string,
  ticketDir: string,
  imagePaths: readonly string[],
  options: RunCodexOptions = {},
): Promise<CodexExecResult> {
  const result = await runAgentExec({
    surface: options.remediation ? 'remediation' : 'diagnosis',
    profile: options.remediation ? 'full' : 'read',
    agent: config.agent,
    codexBin: config.codexBin,
    cwd: config.reposDir,
    env: runnerCodexEnvironment({ remediation: options.remediation === true }),
    timeoutMs: options.timeoutMs || config.codexTimeoutMs,
    prompt,
    addDir: ticketDir,
    permissions: options.remediation
      ? codexSandboxPermissions('danger-full-access')
      : CODEX_READ_NETWORK_PERMISSIONS,
    model: config.codexModel,
    imagePaths,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: sanitize(result.stderr),
  };
}

export function runnerCodexEnvironment(
  { remediation }: { remediation: boolean },
  env: Environment = processEnv(),
) {
  const environment = {
    ...codexEnvironment({ gitIdentity: true }, env),
    ...goDependencyEnvironment(dependencyCacheDir),
  };
  if (!remediation) return environment;
  const realPath = env.PATH || '';
  const githubEnvironment = pickEnv(GITHUB_HELPER_ENVIRONMENT, env);
  if (env.GITHUB_AUTH_MODE !== 'static') delete githubEnvironment.GH_TOKEN;
  return {
    ...environment,
    ...githubEnvironment,
    PATH: `/app/github-bin:${realPath}`,
    DRIVA_REAL_PATH: realPath,
  };
}
