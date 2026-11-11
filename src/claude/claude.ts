import { constants } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentProfile } from '../agent/agent-runtime.js';
import { runProcess } from '../common/run-process.js';
import type { ClaudeConfig } from '../config/agent-config.js';

const READ_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'Skill'] as const;
const ENV_FILE_SCAN_DEPTH = 4;
const LANGUAGE_INSTRUCTION =
  'Escreva todo o texto da resposta em português do Brasil, inclusive os campos do JSON.';
const CODEX_ONLY_ENVIRONMENT = [
  'CODEX_CA_CERTIFICATE',
  'CODEX_HOME',
  'CODEX_MODEL',
  'DRIVA_PROXY_API_KEY',
] as const;

export interface ClaudeExecOptions {
  claude: ClaudeConfig;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  timeoutMs: number;
  prompt: string;
  addDir: string;
  profile: AgentProfile;
  imagePaths?: readonly string[];
}

export interface ClaudeStreamSummary {
  text: string;
  isError: boolean;
  servedModels: string[];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
  };
}

export interface ClaudeExecResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown) {
  return typeof value === 'number' ? value : 0;
}

export function claudePrompt(
  prompt: string,
  imagePaths: readonly string[] = [],
) {
  const adapted = prompt
    .replaceAll('$CODEX_HOME/skills', '$CLAUDE_CONFIG_DIR/skills')
    .replace(/\$(driva-[a-z-]+)/g, 'a skill $1');
  if (!imagePaths.length) return `${adapted}\n\n${LANGUAGE_INSTRUCTION}`;
  const list = imagePaths.map((imagePath) => `- ${imagePath}`).join('\n');
  return `${adapted}\n\nIMAGENS: leia cada arquivo abaixo com a ferramenta Read antes de concluir.\n${list}\n\n${LANGUAGE_INSTRUCTION}`;
}

export function claudeArgs(
  options: Pick<ClaudeExecOptions, 'claude' | 'addDir' | 'profile'>,
) {
  return [
    '-p',
    '--model',
    options.claude.model,
    '--effort',
    options.claude.effort,
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--add-dir',
    options.addDir,
    ...(options.profile === 'full'
      ? ['--permission-mode', 'bypassPermissions']
      : ['--tools', READ_TOOLS.join(',')]),
  ];
}

export function claudeSettings(profile: AgentProfile) {
  if (profile === 'full') return {};
  return {
    permissions: {
      allow: READ_TOOLS,
      deny: ['Write', 'Edit', 'WebFetch', 'WebSearch'],
    },
  };
}

export function claudeEnvironment(
  options: Pick<ClaudeExecOptions, 'claude' | 'env' | 'profile'>,
  home: string,
) {
  const environment: Record<string, string | undefined> = {
    ...options.env,
    ANTHROPIC_BASE_URL: options.claude.baseUrl,
    ANTHROPIC_AUTH_TOKEN: options.claude.authToken,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: options.claude.smallModel,
    CLAUDE_CONFIG_DIR: path.join(home, 'config'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    TMPDIR: path.join(home, 'tmp'),
  };
  for (const name of CODEX_ONLY_ENVIRONMENT) delete environment[name];
  if (options.profile !== 'full') {
    if (options.env.HOME)
      environment.GIT_CONFIG_GLOBAL = path.join(options.env.HOME, '.gitconfig');
    environment.HOME = path.join(home, 'user');
  }
  return environment;
}

export function readSandboxArgs(input: {
  home: string;
  cwd: string;
  hiddenPaths: readonly string[];
  writablePaths: readonly string[];
  readablePaths: readonly string[];
  maskedFiles: readonly string[];
}) {
  return [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--bind',
    input.home,
    input.home,
    ...input.readablePaths.flatMap((item) => ['--ro-bind', item, item]),
    ...input.hiddenPaths.flatMap((item) => ['--tmpfs', item]),
    ...input.writablePaths.flatMap((item) => ['--bind', item, item]),
    ...input.maskedFiles.flatMap((item) => ['--ro-bind', '/dev/null', item]),
    '--chdir',
    input.cwd,
    '--die-with-parent',
    '--unshare-pid',
    '--',
  ];
}

export function parseClaudeStream(stdout: string): ClaudeStreamSummary {
  const summary: ClaudeStreamSummary = {
    text: '',
    isError: true,
    servedModels: [],
    usage: { input: 0, output: 0, cacheRead: 0 },
  };
  const models = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (event.type === 'assistant' && !event.parent_tool_use_id) {
      const model = record(event.message).model;
      if (typeof model === 'string') models.add(model);
    }
    if (event.type === 'result') {
      const usage = record(event.usage);
      const text = typeof event.result === 'string' ? event.result : '';
      const succeeded = event.is_error === false;
      if (succeeded && !summary.isError) {
        summary.text += `\n\n${text}`;
      } else if (summary.isError) {
        summary.text = text;
        summary.isError = !succeeded;
      }
      summary.usage = {
        input: summary.usage.input + tokens(usage.input_tokens),
        output: summary.usage.output + tokens(usage.output_tokens),
        cacheRead:
          summary.usage.cacheRead + tokens(usage.cache_read_input_tokens),
      };
    }
  }
  summary.servedModels = [...models];
  return summary;
}

export function claudeExecOutcome(
  summary: ClaudeStreamSummary,
  requestedModel: string,
  exitCode: number,
): { exitCode: number; stdout: string; diagnostics: string } {
  const expected = requestedModel.split('/').at(-1);
  const usage = `claude usage: models=${summary.servedModels.join(',') || 'none'} input=${summary.usage.input} output=${summary.usage.output} cache_read=${summary.usage.cacheRead}`;
  const unexpected =
    !summary.servedModels.length ||
    summary.servedModels.some((model) => model !== expected);
  if (summary.isError) {
    const kind = /rate.?limit|usage limit|\b429\b/i.test(summary.text)
      ? 'rate_limited'
      : 'claude_error';
    return {
      exitCode: exitCode || 1,
      stdout: '',
      diagnostics: `${kind}: ${summary.text.slice(0, 2000)}\n${usage}`,
    };
  }
  if (unexpected)
    return {
      exitCode: 1,
      stdout: '',
      diagnostics: `unexpected_model: requested ${requestedModel}\n${usage}`,
    };
  return { exitCode, stdout: summary.text, diagnostics: usage };
}

async function exists(item: string) {
  try {
    await access(item, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function existingPaths(items: readonly string[]) {
  const found = await Promise.all(items.map(exists));
  return items.filter((_, index) => found[index]);
}

export async function findEnvFiles(
  root: string,
  depth = ENV_FILE_SCAN_DEPTH,
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries
      .filter(
        (entry) =>
          depth > 0 &&
          entry.isDirectory() &&
          !['.git', 'node_modules'].includes(entry.name),
      )
      .map((entry) => findEnvFiles(path.join(root, entry.name), depth - 1)),
  );
  return [
    ...entries
      .filter((entry) => entry.isFile() && entry.name === '.env')
      .map((entry) => path.join(root, entry.name)),
    ...nested.flat(),
  ];
}

async function prepareClaudeHome(claude: ClaudeConfig, profile: AgentProfile) {
  const home = await mkdtemp(path.join(tmpdir(), 'claude-run-'));
  await Promise.all(
    ['config', 'tmp', 'user'].map((name) =>
      mkdir(path.join(home, name), { recursive: true }),
    ),
  );
  await cp(claude.skillsDir, path.join(home, 'config', 'skills'), {
    recursive: true,
  });
  await writeFile(
    path.join(home, 'config', 'settings.json'),
    JSON.stringify(claudeSettings(profile)),
    { mode: 0o600 },
  );
  return home;
}

async function readCommand(options: ClaudeExecOptions, home: string) {
  const temporaryRoot = `${tmpdir()}${path.sep}`;
  const readablePaths = [
    ...options.claude.readOnlyPaths,
    ...[options.cwd, options.addDir].filter((item) =>
      item.startsWith(temporaryRoot),
    ),
  ];
  return readSandboxArgs({
    home,
    cwd: options.cwd,
    hiddenPaths: await existingPaths(options.claude.hiddenPaths),
    writablePaths: await existingPaths(options.claude.writablePaths),
    readablePaths,
    maskedFiles:
      options.profile === 'communication'
        ? await findEnvFiles(options.cwd)
        : [],
  });
}

export async function runClaudeExec(
  options: ClaudeExecOptions,
): Promise<ClaudeExecResult> {
  const home = await prepareClaudeHome(options.claude, options.profile);
  try {
    const args = claudeArgs(options);
    const [command, commandArgs] =
      options.profile === 'full'
        ? [options.claude.bin, args]
        : [
            'bwrap',
            [
              ...(await readCommand(options, home)),
              options.claude.bin,
              ...args,
            ],
          ];
    const result = await runProcess(command, commandArgs, {
      cwd: options.cwd,
      env: claudeEnvironment(options, home),
      timeoutMs: options.timeoutMs,
      input: claudePrompt(options.prompt, options.imagePaths),
    });
    const outcome = claudeExecOutcome(
      parseClaudeStream(result.stdout),
      options.claude.model,
      result.exitCode ?? 1,
    );
    return {
      exitCode: outcome.exitCode,
      signal: result.signal,
      stdout: outcome.stdout,
      stderr: [result.stderr.trim(), outcome.diagnostics]
        .filter(Boolean)
        .join('\n'),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
