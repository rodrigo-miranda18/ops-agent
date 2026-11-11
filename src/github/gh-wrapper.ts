#!/usr/bin/env node

import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { sanitize } from '../common/sanitize.js';
import {
  githubConfigFromEnv,
  type GitHubConfig,
} from '../config/github-config.js';
import {
  createGitHubCredentialProvider,
  type GitHubCredentialProvider,
} from './github-credentials.js';
import { githubProcessEnvironment } from './github-environment.js';

export interface GhWrapperDependencies {
  createCredentials(config: GitHubConfig): GitHubCredentialProvider;
  spawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcess;
}

const DEFAULT_DEPENDENCIES: GhWrapperDependencies = {
  createCredentials: createGitHubCredentialProvider,
  spawn,
};

export async function runGhWrapper(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  dependencies: Partial<GhWrapperDependencies> = {},
): Promise<number> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  try {
    const realPath = env.DRIVA_REAL_PATH?.trim();
    if (!realPath) throw new Error('DRIVA_REAL_PATH is required');
    const credentials = deps.createCredentials(githubConfigFromEnv(env));
    const credential = await credentials.getCredential();
    const child = deps.spawn('gh', args, {
      cwd: process.cwd(),
      env: githubProcessEnvironment(
        { ...env, PATH: realPath },
        credential.token,
      ),
      stdio: 'inherit',
    });
    return await childExitCode(child);
  } catch (error) {
    process.stderr.write(
      `GitHub CLI wrapper failed: ${sanitize((error as Error).message)}\n`,
    );
    return 1;
  }
}

function childExitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
    const onSigterm = () => forwardSignal('SIGTERM');
    const onSigint = () => forwardSignal('SIGINT');
    const cleanup = () => {
      process.off('SIGTERM', onSigterm);
      process.off('SIGINT', onSigint);
    };
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exitCode);
    };
    process.on('SIGTERM', onSigterm);
    process.on('SIGINT', onSigint);
    child.once('error', (error) => {
      process.stderr.write(
        `GitHub CLI wrapper failed: ${sanitize(error.message)}\n`,
      );
      finish(1);
    });
    child.once('close', (exitCode, signal) =>
      finish(signal ? 1 : (exitCode ?? 1)),
    );
  });
}

export function isWrapperEntrypoint(
  moduleUrl: string,
  invokedPath: string | undefined,
): boolean {
  if (!invokedPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invokedPath);
  } catch {
    return false;
  }
}

if (isWrapperEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runGhWrapper(process.argv.slice(2), process.env);
}
