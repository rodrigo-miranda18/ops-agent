import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { dependencyEnvironment } from '../config/runner-config.js';
import { writeJsonAtomic } from '../state/atomic-write.js';
import { runGit, type Log } from './git.js';
import { goDependencyEnvironment } from './go-environment.js';

export const DEPENDENCY_SYNC_VERSION = 2;

export const DEPENDENCY_MANAGERS = ['npm', 'pnpm', 'go'] as const;
export type DependencyManager = (typeof DEPENDENCY_MANAGERS)[number];

export interface DependencyProject {
  name: string;
  directory: string;
  manager: DependencyManager;
  files: readonly string[];
}

export interface DependencySyncConfig {
  enabled: boolean;
  reposDir: string;
  timeoutMs: number;
  repositorySyncTimeoutMs: number;
  cacheDir: string;
  stateFile: string;
}

interface DependencyState {
  version: number;
  projects: Record<
    string,
    { manager: DependencyManager; fingerprint: string; installed_at: string }
  >;
}

const NPM_FILES = ['package.json', 'package-lock.json'];
const PNPM_FILES = ['package.json', 'pnpm-lock.yaml'];
const GO_FILES = ['go.mod', 'go.sum'];

export function dependencyProjects(reposDir: string): DependencyProject[] {
  const project = (
    name: string,
    manager: DependencyManager,
    files: readonly string[],
  ): DependencyProject => ({
    name,
    directory: path.join(reposDir, ...name.split('/')),
    manager,
    files,
  });
  return [
    project('service-04', 'npm', NPM_FILES),
    project('service-12', 'go', GO_FILES),
    project('service-17', 'npm', NPM_FILES),
    project('service-11', 'npm', NPM_FILES),
    project('service-16', 'go', GO_FILES),
    project('service-09/linkedin-api', 'pnpm', PNPM_FILES),
    project('service-09/linkedin-worker', 'pnpm', PNPM_FILES),
    project('service-09/agentic-extension', 'pnpm', PNPM_FILES),
    project('service-15', 'npm', NPM_FILES),
    project('service-02', 'npm', NPM_FILES),
    project('service-05', 'npm', NPM_FILES),
    project('service-13', 'go', GO_FILES),
    project('service-01', 'go', GO_FILES),
    project('service-06', 'go', GO_FILES),
  ];
}

export function dependencyInstallationPaths(
  reposDir: string,
  cacheDir: string,
): readonly string[] {
  return dependencyProjects(reposDir).map((project) =>
    project.manager === 'go'
      ? goMarker(cacheDir, project)
      : path.join(project.directory, 'node_modules'),
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export async function synchronizeDependencies(
  config: DependencySyncConfig,
  log: Log,
): Promise<void> {
  if (!config.enabled) {
    log('Dependency synchronization is disabled');
    return;
  }

  await mkdir(config.cacheDir, { recursive: true });
  const state = await readDependencyState(config.stateFile);
  for (const project of dependencyProjects(config.reposDir)) {
    const fingerprint = await dependencyFingerprint(project);
    const ready = await dependencyInstallationExists(config, project);
    const previous = state.projects[project.name];
    if (ready && previous?.fingerprint === fingerprint) {
      log(`Dependencies ready: ${project.name} (${fingerprint.slice(0, 12)})`);
      continue;
    }

    const reason = !ready ? 'installation missing' : 'lockfiles changed';
    log(`Installing dependencies for ${project.name}: ${reason}`);
    await installDependencies(config, project);
    state.projects[project.name] = {
      manager: project.manager,
      fingerprint,
      installed_at: new Date().toISOString(),
    };
    await writeJsonAtomic(config.stateFile, state);
  }
}

async function readDependencyState(
  stateFile: string,
): Promise<DependencyState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8')) as unknown;
    if (isDependencyState(parsed)) return parsed;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return { version: DEPENDENCY_SYNC_VERSION, projects: {} };
}

function isDependencyState(value: unknown): value is DependencyState {
  if (typeof value !== 'object' || value === null) return false;
  const { version, projects } = value as Partial<DependencyState>;
  return (
    version === DEPENDENCY_SYNC_VERSION &&
    !!projects &&
    typeof projects === 'object'
  );
}

export async function dependencyFingerprint(
  project: DependencyProject,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(
    `dependency-sync:${DEPENDENCY_SYNC_VERSION}\nmanager:${project.manager}\nnode:${process.version}\n`,
  );
  for (const filename of project.files) {
    const absolute = path.join(project.directory, filename);
    let content: Buffer;
    try {
      content = await readFile(absolute);
    } catch (error) {
      if (errorCode(error) === 'ENOENT')
        throw new Error(
          `Dependency file is missing for ${project.name}: ${filename}`,
          { cause: error },
        );
      throw error;
    }
    hash.update(`file:${filename}\n`);
    hash.update(content);
  }
  return hash.digest('hex');
}

function goMarker(cacheDir: string, project: DependencyProject): string {
  return path.join(cacheDir, 'markers', project.name.replaceAll('/', '__'));
}

async function dependencyInstallationExists(
  config: DependencySyncConfig,
  project: DependencyProject,
): Promise<boolean> {
  const target =
    project.manager === 'go'
      ? goMarker(config.cacheDir, project)
      : path.join(project.directory, 'node_modules');
  try {
    await readdir(target);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

export function dependencyInstallCommand(
  cacheDir: string,
  project: DependencyProject,
  baseEnvironment: Record<string, string>,
): { command: string; args: string[]; environment: Record<string, string> } {
  if (project.manager === 'npm')
    return {
      command: 'npm',
      args: ['ci', '--include=dev'],
      environment: {
        ...baseEnvironment,
        npm_config_cache: path.join(cacheDir, 'npm'),
      },
    };
  if (project.manager === 'pnpm')
    return {
      command: 'pnpm',
      args: [
        'install',
        '--frozen-lockfile',
        '--prod=false',
        `--store-dir=${path.join(cacheDir, 'pnpm')}`,
      ],
      environment: baseEnvironment,
    };
  return {
    command: 'go',
    args: ['mod', 'download'],
    environment: {
      ...baseEnvironment,
      ...goDependencyEnvironment(cacheDir),
    },
  };
}

async function installDependencies(
  config: DependencySyncConfig,
  project: DependencyProject,
): Promise<void> {
  const { command, args, environment } = dependencyInstallCommand(
    config.cacheDir,
    project,
    dependencyEnvironment(project.name),
  );
  await runDependencyCommand(config, project, command, args, environment);
  if (project.manager === 'npm') {
    // npm rewrites a committed yarn.lock even with --no-save; a dirty checkout blocks the next repository sync.
    const trackedYarnLock = await runGit(config, project.directory, [
      'ls-files',
      '--',
      'yarn.lock',
    ]);
    if (trackedYarnLock)
      await runGit(config, project.directory, ['checkout', '--', 'yarn.lock']);
  }
  if (project.manager === 'go')
    await mkdir(goMarker(config.cacheDir, project), { recursive: true });
}

function runDependencyCommand(
  config: DependencySyncConfig,
  project: DependencyProject,
  command: string,
  args: readonly string[],
  environment: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sandboxArgs = [
      '--die-with-parent',
      '--new-session',
      '--unshare-pid',
      '--ro-bind',
      '/',
      '/',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/app/secrets',
      '--bind',
      project.directory,
      project.directory,
      '--bind',
      config.cacheDir,
      config.cacheDir,
      '--chdir',
      project.directory,
      '--',
      command,
      ...args,
    ];
    const child = spawn('bwrap', sandboxArgs, {
      cwd: project.directory,
      env: environment,
      stdio: 'inherit',
    });
    const timeout = setTimeout(() => child.kill('SIGTERM'), config.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (exitCode === 0) return resolve();
      reject(
        new Error(
          `Dependency installation failed for ${project.name}: ${command} exited with ${exitCode ?? signal ?? 'unknown status'}`,
        ),
      );
    });
  });
}
