import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../common/run-process.js';
import { sanitize } from '../common/sanitize.js';
import {
  CERTIFICATE_ENVIRONMENT,
  GIT_IDENTITY_ENVIRONMENT,
  GITHUB_HELPER_ENVIRONMENT,
  pickEnv,
  processEnv,
  PROXY_ENVIRONMENT,
  SYSTEM_ENVIRONMENT,
  type Environment,
} from '../config/env.js';

export type Log = (message: string) => void;

export interface GitConfig {
  repositorySyncTimeoutMs: number;
}

export interface RepositorySyncConfig extends GitConfig {
  reposDir: string;
  repositorySyncIgnore: readonly string[];
}

export function gitProcessEnvironment(
  baseEnv: Environment = processEnv(),
): Record<string, string> {
  return {
    ...pickEnv(
      [
        ...SYSTEM_ENVIRONMENT,
        ...CERTIFICATE_ENVIRONMENT,
        ...PROXY_ENVIRONMENT,
        ...GIT_IDENTITY_ENVIRONMENT,
        ...GITHUB_HELPER_ENVIRONMENT,
      ],
      baseEnv,
    ),
    GIT_TERMINAL_PROMPT: '0',
  };
}

export async function runGit(
  config: GitConfig,
  repository: string,
  args: readonly string[],
): Promise<string> {
  const { exitCode, signal, stdout, stderr } = await runProcess('git', args, {
    cwd: repository,
    env: gitProcessEnvironment(),
    timeoutMs: config.repositorySyncTimeoutMs,
  });
  if (exitCode === 0) return stdout.trim();
  const detail = sanitize(
    stderr || stdout || `terminated by ${signal || 'unknown signal'}`,
  );
  throw new Error(
    `git ${args.join(' ')} failed: ${detail.trim().slice(-2000)}`,
  );
}

export async function findGitRepositories(
  root: string,
  ignoredRepositories: readonly string[],
  log: Log,
): Promise<string[]> {
  const repositories: string[] = [];
  const ignored = new Set(
    ignoredRepositories.map((repository) => path.normalize(repository)),
  );
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.name === '.git')) {
      const name = path.relative(root, directory) || '.';
      if (ignored.has(path.normalize(name))) log(`Repository ignored: ${name}`);
      else {
        log(`Repository found: ${name}`);
        repositories.push(directory);
      }
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === 'node_modules' ||
        entry.name.startsWith('.')
      )
        continue;
      await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
  return repositories.sort();
}

export async function synchronizeRepositories(
  config: RepositorySyncConfig,
  log: Log,
): Promise<void> {
  await initializeLinkedinSubmodules(config, log);
  const repositories = await findGitRepositories(
    config.reposDir,
    config.repositorySyncIgnore,
    log,
  );
  if (!repositories.length)
    throw new Error(`No Git repositories found under ${config.reposDir}`);

  const named = repositories.map((repository) => ({
    repository,
    name: path.relative(config.reposDir, repository),
  }));
  log(`Checking ${named.length} repositories before synchronization`);

  for (const { repository, name } of named) {
    const dirty = await runGit(config, repository, ['status', '--porcelain']);
    if (dirty)
      throw new Error(
        `Repository ${name} has local changes; refusing to synchronize it`,
      );
    await runGit(config, repository, ['remote', 'get-url', 'origin']);
    await runGit(config, repository, [
      'rev-parse',
      '--verify',
      'refs/heads/main',
    ]);
  }

  for (const { repository, name } of named) {
    log(`Fetching ${name}`);
    await runGit(config, repository, ['fetch', '--prune', 'origin', 'main']);
  }

  for (const { repository, name } of named) {
    await runGit(config, repository, [
      'rev-parse',
      '--verify',
      'refs/remotes/origin/main',
    ]);
    const localMain = await runGit(config, repository, [
      'rev-parse',
      'refs/heads/main',
    ]);
    const remoteMain = await runGit(config, repository, [
      'rev-parse',
      'refs/remotes/origin/main',
    ]);
    if (localMain !== remoteMain)
      log(
        `Repository ${name} will reset ${localMain.slice(0, 12)} -> ${remoteMain.slice(0, 12)}`,
      );
  }

  for (const { repository, name } of named) {
    await runGit(config, repository, ['switch', 'main']);
    await runGit(config, repository, ['reset', '--hard', 'origin/main']);
    const head = await runGit(config, repository, ['rev-parse', 'HEAD']);
    const remoteMain = await runGit(config, repository, [
      'rev-parse',
      'origin/main',
    ]);
    if (head !== remoteMain)
      throw new Error(`Repository ${name} did not reach origin/main`);
    log(`Repository ${name} ready at ${head.slice(0, 12)}`);
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

export async function initializeLinkedinSubmodules(
  config: RepositorySyncConfig,
  log: Log,
): Promise<void> {
  const parent = path.join(config.reposDir, 'service-09');
  let definitions: string;
  try {
    definitions = await readFile(path.join(parent, '.gitmodules'), 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return;
    throw error;
  }

  const paths = Array.from(
    definitions.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm),
    (match) => match[1] ?? '',
  );
  if (!paths.length) return;
  await runGit(config, parent, ['submodule', 'sync', '--recursive']);
  for (const relativePath of paths) {
    const repository = path.resolve(parent, relativePath);
    if (!repository.startsWith(`${parent}${path.sep}`))
      throw new Error(`Unsafe submodule path in service-09: ${relativePath}`);
    try {
      await stat(path.join(repository, '.git'));
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      log(`Initializing service-09 submodule: ${relativePath}`);
      await runGit(config, parent, [
        'submodule',
        'update',
        '--init',
        '--recursive',
        '--',
        relativePath,
      ]);
    }

    try {
      await runGit(config, repository, ['switch', 'main']);
    } catch {
      await runGit(config, repository, [
        'switch',
        '--create',
        'main',
        '--track',
        'origin/main',
      ]);
    }
  }
}
