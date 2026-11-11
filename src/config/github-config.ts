import { accessSync, constants } from 'node:fs';
import { type Environment } from './env.js';

export const GITHUB_AUTH_MODES = ['static', 'app'] as const;
export type GitHubAuthMode = (typeof GITHUB_AUTH_MODES)[number];

export interface StaticGitHubConfig {
  mode: 'static';
  token: string;
}

export interface AppGitHubConfig {
  mode: 'app';
  appId: string;
  clientId: string;
  organization: string;
  healthRepository: string;
  privateKeyFile: string;
  installationId?: number;
  tokenRefreshSkewMs: number;
}

export type GitHubConfig = StaticGitHubConfig | AppGitHubConfig;

export const GITHUB_CONFIG = Symbol('GITHUB_CONFIG');

const DEFAULT_TOKEN_REFRESH_SKEW_SECONDS = 300;

export function githubConfigFromEnv(
  env: Environment = process.env,
): GitHubConfig {
  const mode =
    env.GITHUB_AUTH_MODE?.trim() || (env.GH_TOKEN?.trim() ? 'static' : '');
  if (!isGitHubAuthMode(mode)) {
    const suffix = mode ? `, received: ${mode}` : '';
    throw new Error(`GITHUB_AUTH_MODE must be static or app${suffix}`);
  }

  if (mode === 'static') {
    const token = required(env, 'GH_TOKEN', mode);
    return { mode, token };
  }

  const privateKeyFile = required(env, 'GITHUB_APP_PRIVATE_KEY_FILE', mode);
  try {
    accessSync(privateKeyFile, constants.R_OK);
  } catch {
    throw new Error(
      `GITHUB_APP_PRIVATE_KEY_FILE is not readable: ${privateKeyFile}`,
    );
  }

  const installationId = optionalPositiveInteger(
    env.GITHUB_APP_INSTALLATION_ID,
    'GITHUB_APP_INSTALLATION_ID',
  );
  const tokenRefreshSkewSeconds = integerInRange(
    env.GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS ??
      String(DEFAULT_TOKEN_REFRESH_SKEW_SECONDS),
    'GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS',
    1,
    3599,
  );

  return {
    mode,
    appId: required(env, 'GITHUB_APP_ID', mode),
    clientId: required(env, 'GITHUB_APP_CLIENT_ID', mode),
    organization: required(env, 'GITHUB_APP_ORGANIZATION', mode),
    healthRepository: required(env, 'GITHUB_APP_HEALTH_REPOSITORY', mode),
    privateKeyFile,
    ...(installationId === undefined ? {} : { installationId }),
    tokenRefreshSkewMs: tokenRefreshSkewSeconds * 1000,
  };
}

function isGitHubAuthMode(value: string): value is GitHubAuthMode {
  return (GITHUB_AUTH_MODES as readonly string[]).includes(value);
}

function required(
  env: Environment,
  name: string,
  mode: GitHubAuthMode,
): string {
  const value = env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required when GITHUB_AUTH_MODE=${mode}`);
  return value;
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function integerInRange(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value))
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum)
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  return parsed;
}
