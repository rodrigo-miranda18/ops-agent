import { runProcess, type ProcessResult } from '../common/run-process.js';
import { sanitize } from '../common/sanitize.js';
import { processEnv, type Environment } from '../config/env.js';
import type { GitHubCredentialProvider } from './github-credentials.js';
import { githubProcessEnvironment } from './github-environment.js';

export interface GhOptions {
  cwd?: string;
  timeoutMs: number;
  env?: Readonly<Record<string, string | undefined>>;
  formatError?: (
    args: readonly string[],
    result: { exitCode: number | null; signal: string | null },
    output: { stdout: string; stderr: string },
  ) => string;
}

export type GitHubExecutor = (args: readonly string[]) => Promise<string>;

export interface GitHubExecutorOptions {
  credentials: GitHubCredentialProvider;
  cwd?: string;
  timeoutMs: number;
  baseEnv: Environment;
  command?: string;
  formatError?: GhOptions['formatError'];
}

export function runnerGhError(
  args: readonly string[],
  result: { signal: string | null },
  output: { stdout: string; stderr: string },
): string {
  return `gh ${args.slice(0, 2).join(' ')} failed: ${sanitize(output.stderr || output.stdout || result.signal).slice(-2000)}`;
}

export function serviceGhError(
  args: readonly string[],
  result: { exitCode: number | null },
  output: { stdout: string; stderr: string },
): string {
  return `gh ${args.slice(0, 2).join(' ')} failed (${result.exitCode}): ${sanitize(
    output.stderr || output.stdout,
  )
    .trim()
    .slice(0, 500)}`;
}

export async function runGh(
  args: readonly string[],
  options: GhOptions,
): Promise<string> {
  const result = await runProcess('gh', args, {
    cwd: options.cwd,
    env: options.env ?? processEnv(),
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode === 0) return result.stdout.trim();
  const format = options.formatError ?? runnerGhError;
  throw new Error(format(args, result, result));
}

export function createGitHubExecutor(
  options: GitHubExecutorOptions,
): GitHubExecutor {
  return async (args) => {
    let result = await executeGitHubProcess(options, args);
    if (result.exitCode !== 0 && isExpiredAuthentication(result)) {
      options.credentials.invalidate();
      result = await executeGitHubProcess(options, args);
    }
    if (result.exitCode === 0) return result.stdout.trim();
    const format = options.formatError ?? runnerGhError;
    throw new Error(format(args, result, result));
  };
}

async function executeGitHubProcess(
  options: GitHubExecutorOptions,
  args: readonly string[],
): Promise<ProcessResult> {
  const credential = await options.credentials.getCredential();
  return runProcess(options.command ?? 'gh', args, {
    cwd: options.cwd,
    env: githubProcessEnvironment(options.baseEnv, credential.token),
    timeoutMs: options.timeoutMs,
  });
}

function isExpiredAuthentication(result: ProcessResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return (
    /bad credentials/i.test(output) ||
    /(?:http[^\n]*\b401\b|\b401\b[^\n]*unauthorized)/i.test(output)
  );
}

export function runnerGh(
  config: { reposDir: string; repositorySyncTimeoutMs: number },
  args: readonly string[],
): Promise<string> {
  return runGh(args, {
    cwd: config.reposDir,
    env: { ...processEnv(), GH_PROMPT_DISABLED: 'true' },
    timeoutMs: config.repositorySyncTimeoutMs,
    formatError: runnerGhError,
  });
}
