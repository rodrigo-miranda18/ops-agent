import path from 'node:path';
import { agentConfigFromEnv, type AgentConfig } from './agent-config.js';
import { appReposDir, codexBin, codexModel } from './app-config.js';
import { codexEnvironment } from './env.js';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');

export interface RuntimeConfig {
  cwd: string;
  stateDir: string;
  resultsDir: string;
  reposDir: string;
  codexBin: string;
  codexModel: string | undefined;
  codexEnv: Record<string, string>;
  agent: AgentConfig;
  processEnv: NodeJS.ProcessEnv;
}

export function runtimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): RuntimeConfig {
  return {
    cwd,
    stateDir: path.resolve(cwd, 'state'),
    resultsDir: path.resolve(cwd, 'results'),
    reposDir: appReposDir(env),
    codexBin: codexBin(env),
    codexModel: codexModel(env),
    codexEnv: codexEnvironment({}, env),
    agent: agentConfigFromEnv(env),
    processEnv: env,
  };
}
