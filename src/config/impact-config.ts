import path from 'node:path';
import { agentConfigFromEnv } from './agent-config.js';
import type { Environment } from './env.js';

export function impactCodexConfigFromEnv(
  projectDir: string,
  env: Environment = process.env,
) {
  return {
    reposDir: path.resolve(
      env.DRIVA_REPOS_DIR || path.join(projectDir, 'repos'),
    ),
    codexBin: env.CODEX_BIN || 'codex',
    agent: agentConfigFromEnv(env),
    model: env.CODEX_MODEL,
    sandboxMode: env.IMPACT_CODEX_SANDBOX_MODE,
    timeoutMs: Number(
      env.IMPACT_CODEX_TIMEOUT_MS || env.CODEX_TIMEOUT_MS || 900_000,
    ),
  };
}

export type ImpactCodexConfig = ReturnType<typeof impactCodexConfigFromEnv>;
