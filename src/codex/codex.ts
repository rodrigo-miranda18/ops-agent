import { runProcess, type ProcessResult } from '../common/run-process.js';

export const CODEX_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export const CODEX_READ_NETWORK_PERMISSIONS =
  'default_permissions="driva-debug-read-network"';

export const CODEX_COMMUNICATION_PERMISSIONS =
  'default_permissions="driva-communication-read-network"';

export function codexSandboxPermissions(mode: CodexSandboxMode) {
  return `sandbox_mode="${mode}"`;
}

export interface CodexExecOptions {
  codexBin: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  prompt: string;
  addDir: string;
  permissions: string;
  model?: string;
  imagePaths?: readonly string[];
}

export interface CodexExecResult extends ProcessResult {
  exitCode: number;
}

export function codexExecArgs(
  options: Pick<
    CodexExecOptions,
    'addDir' | 'permissions' | 'model' | 'imagePaths'
  >,
) {
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--add-dir',
    options.addDir,
    '-c',
    options.permissions,
    '-c',
    'approval_policy="never"',
    '-c',
    'allow_login_shell=false',
  ];
  if (options.model) args.push('--model', options.model);
  for (const imagePath of options.imagePaths ?? [])
    args.push('--image', imagePath);
  args.push('-');
  return args;
}

export async function runCodexExec(
  options: CodexExecOptions,
): Promise<CodexExecResult> {
  const result = await runProcess(options.codexBin, codexExecArgs(options), {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    input: options.prompt,
  });
  return { ...result, exitCode: result.exitCode ?? 1 };
}
