import {
  DIAGNOSIS_ENV_FILES,
  diagnosisEnvFile,
  type RunnerConfig,
} from '../config/runner-config.js';
import { synchronizeDependencies } from '../git/dependencies.js';
import { writeFileAtomic } from '../state/atomic-write.js';
import { runnerLogger } from './runner-logger.js';
import { dependencyCacheDir, dependencyStateFile } from './runner-paths.js';

export function syncDependencies(
  config: Pick<
    RunnerConfig,
    | 'dependencySyncEnabled'
    | 'reposDir'
    | 'dependencySyncTimeoutMs'
    | 'repositorySyncTimeoutMs'
  >,
) {
  return synchronizeDependencies(
    {
      enabled: config.dependencySyncEnabled,
      reposDir: config.reposDir,
      timeoutMs: config.dependencySyncTimeoutMs,
      repositorySyncTimeoutMs: config.repositorySyncTimeoutMs,
      cacheDir: dependencyCacheDir,
      stateFile: dependencyStateFile,
    },
    (message) => runnerLogger.info(message),
  );
}

export async function materializeDiagnosisEnvFiles(
  config: Pick<RunnerConfig, 'reposDir'>,
): Promise<void> {
  for (const definition of DIAGNOSIS_ENV_FILES) {
    const file = diagnosisEnvFile(definition, config.reposDir);
    if (!file.configured) {
      runnerLogger.info(
        `Diagnosis database configuration not provided: ${definition.name}`,
      );
      continue;
    }
    await writeFileAtomic(file.filename, file.content);
    runnerLogger.info(
      `Diagnosis database environment ready: ${definition.name}`,
    );
  }
}
