import { processEnv, type Environment } from '../config/env.js';
import type { RunnerConfig } from '../config/runner-config.js';
import {
  createGitHubExecutor,
  runnerGhError,
  type GitHubExecutor,
} from '../github/gh.js';
import { createGitHubCredentialProvider } from '../github/github-credentials.js';

export interface RunnerDependencies {
  github: GitHubExecutor;
  ensureGitHubAccess(repositories?: readonly string[]): Promise<void>;
}

export function createRunnerDependencies(
  config: Pick<RunnerConfig, 'github' | 'reposDir' | 'repositorySyncTimeoutMs'>,
  env: Environment = processEnv(),
): RunnerDependencies {
  const credentials = createGitHubCredentialProvider(config.github);
  const github = createGitHubExecutor({
    credentials,
    cwd: config.reposDir,
    timeoutMs: config.repositorySyncTimeoutMs,
    baseEnv: env,
    formatError: runnerGhError,
  });
  return {
    github,
    async ensureGitHubAccess(repositories = []) {
      if (config.github.mode === 'static') {
        await github(['api', 'user', '--jq', '.login']);
        return;
      }

      const targets = repositories.length
        ? [...new Set(repositories)]
        : [config.github.healthRepository];
      for (const repository of targets) {
        await github([
          'api',
          `/repos/${config.github.organization}/${repository}`,
          '--jq',
          '.full_name',
        ]);
      }
    },
  };
}
