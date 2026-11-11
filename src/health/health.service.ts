import { Inject, Injectable } from '@nestjs/common';
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  configurationSummary,
  googleApplicationCredentials,
} from '../config/app-config.js';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import {
  GITHUB_CONFIG,
  type GitHubAuthMode,
  type GitHubConfig,
} from '../config/github-config.js';
import { sanitize } from '../common/sanitize.js';
import { GithubService } from '../github/github.service.js';
import {
  GITHUB_CREDENTIAL_PROVIDER,
  type GitHubCredentialProvider,
} from '../github/github-credentials.js';

export interface CommandCheck {
  ok: boolean;
  version?: string;
}

export interface GitHubHealthCheck {
  ok: boolean;
  mode: GitHubAuthMode;
  appId?: string;
  installationId?: number;
  expiresAt?: string;
  repositoryAccess?: boolean;
  error?: string;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
    @Inject(GITHUB_CONFIG) private readonly githubConfig: GitHubConfig,
    @Inject(GITHUB_CREDENTIAL_PROVIDER)
    private readonly githubCredentials: GitHubCredentialProvider,
    private readonly github: GithubService,
  ) {}

  async dependencies() {
    const { reposDir, stateDir, resultsDir, processEnv: env } = this.runtime;
    const usesClaude = Object.values(this.runtime.agent.runtimes).includes(
      'claude',
    );
    const [
      codex,
      claude,
      github,
      githubAuth,
      git,
      go,
      pnpm,
      python,
      repos,
      reposWritable,
      stateWritable,
      resultsWritable,
    ] = await Promise.all([
      commandVersion(this.runtime.codexBin, ['--version'], env),
      usesClaude
        ? commandVersion(this.runtime.agent.claude.bin, ['--version'], env)
        : undefined,
      commandVersion('gh', ['--version'], env),
      this.githubHealth(),
      commandVersion('git', ['--version'], env),
      commandVersion('go', ['version'], env),
      commandVersion('pnpm', ['--version'], env),
      commandVersion('python3', ['--version'], env),
      countRepositories(reposDir),
      directoryWritable(reposDir),
      directoryWritable(stateDir),
      directoryWritable(resultsDir),
    ]);

    const checks = {
      codex,
      ...(claude ? { claude } : {}),
      github,
      githubAuth,
      git,
      go,
      pnpm,
      python,
      directories: {
        repos: { writable: reposWritable, repositories: repos },
        state: { writable: stateWritable },
        results: { writable: resultsWritable },
      },
      configuration: {
        ...configurationSummary(env),
        googleCredentials: await googleCredentialsConfigured(env),
      },
    };
    const ok =
      codex.ok &&
      (claude?.ok ?? true) &&
      github.ok &&
      githubAuth.ok &&
      git.ok &&
      go.ok &&
      pnpm.ok &&
      python.ok &&
      reposWritable &&
      stateWritable &&
      resultsWritable &&
      repos > 0 &&
      Object.values(checks.configuration).every(Boolean);

    return {
      status: ok ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async githubHealth(): Promise<GitHubHealthCheck> {
    if (this.githubConfig.mode === 'static') {
      try {
        await this.github.execute(['api', 'user', '--jq', '.login']);
        return { ok: true, mode: 'static' };
      } catch (error) {
        return { ok: false, mode: 'static', error: sanitizedError(error) };
      }
    }

    const base = {
      mode: this.githubConfig.mode,
      appId: this.githubConfig.appId,
    } as const;

    try {
      const credential = await this.githubCredentials.getCredential();
      const identity = {
        ...base,
        ...(credential.installationId === null
          ? {}
          : { installationId: credential.installationId }),
        ...(credential.expiresAt === null
          ? {}
          : { expiresAt: credential.expiresAt.toISOString() }),
      };

      try {
        await this.github.execute([
          'api',
          `/repos/${this.githubConfig.organization}/${this.githubConfig.healthRepository}`,
          '--jq',
          '.full_name',
        ]);
        return { ...identity, ok: true, repositoryAccess: true };
      } catch (error) {
        return {
          ...identity,
          ok: false,
          repositoryAccess: false,
          error: sanitizedError(error),
        };
      }
    } catch (error) {
      return { ...base, ok: false, error: sanitizedError(error) };
    }
  }
}

function sanitizedError(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : error).slice(0, 500);
}

async function directoryWritable(directory: string) {
  try {
    await access(directory, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function googleCredentialsConfigured(env: NodeJS.ProcessEnv) {
  const filename = googleApplicationCredentials(env);
  if (!filename) return false;
  try {
    await access(filename, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function countRepositories(root: string) {
  let count = 0;
  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === '.git')) count += 1;
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
  return count;
}

function commandVersion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  return new Promise<CommandCheck>((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 5_000);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolve({ ok: false });
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve(
        code === 0
          ? {
              ok: true,
              version: output.trim().split(/\r?\n/, 1)[0]?.slice(0, 200),
            }
          : { ok: false },
      );
    });
  });
}
