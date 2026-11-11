import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type AppGitHubConfig,
  type GitHubConfig,
} from '../config/github-config.js';
import {
  parseGitHubInstallationResponse,
  parseGitHubTokenResponse,
} from './github-api.types.js';

export interface GitHubCredential {
  token: string;
  expiresAt: Date | null;
  installationId: number | null;
}

export interface GitHubCredentialProvider {
  getCredential(): Promise<GitHubCredential>;
  invalidate(): void;
}

export const GITHUB_CREDENTIAL_PROVIDER = Symbol('GITHUB_CREDENTIAL_PROVIDER');

export interface GitHubCredentialDependencies {
  fetch: typeof fetch;
  now: () => Date;
  readPrivateKey: (filename: string) => Promise<string>;
  requestTimeoutMs: number;
  timeoutSignal: (timeoutMs: number) => AbortSignal;
}

const DEFAULT_DEPENDENCIES: GitHubCredentialDependencies = {
  fetch: globalThis.fetch,
  now: () => new Date(),
  readPrivateKey: async (filename) => readFile(filename, 'utf8'),
  requestTimeoutMs: 30_000,
  timeoutSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
};

const API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
} as const;

export function createGitHubCredentialProvider(
  config: GitHubConfig,
  dependencies: Partial<GitHubCredentialDependencies> = {},
): GitHubCredentialProvider {
  if (config.mode === 'static') {
    const credential: GitHubCredential = {
      token: config.token,
      expiresAt: null,
      installationId: null,
    };
    return {
      getCredential: async () => credential,
      invalidate: () => undefined,
    };
  }

  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const { requestJson, installationId } = createAppApi(config, deps);
  let cachedCredential: GitHubCredential | undefined;
  let refreshPromise: Promise<GitHubCredential> | undefined;

  const refresh = async (): Promise<GitHubCredential> => {
    const id = await installationId();
    const response = await requestJson(
      `https://api.github.com/app/installations/${id}/access_tokens`,
      'POST',
      'creating an installation token',
    );
    const token = parseGitHubTokenResponse(response);
    const credential: GitHubCredential = {
      token: token.token,
      expiresAt: token.expiresAt,
      installationId: id,
    };
    cachedCredential = credential;
    return credential;
  };

  return {
    async getCredential() {
      if (
        cachedCredential?.expiresAt &&
        deps.now().getTime() <
          cachedCredential.expiresAt.getTime() - config.tokenRefreshSkewMs
      ) {
        return cachedCredential;
      }
      refreshPromise ??= refresh().finally(() => {
        refreshPromise = undefined;
      });
      return refreshPromise;
    },
    invalidate() {
      cachedCredential = undefined;
    },
  };
}

function createAppApi(
  config: AppGitHubConfig,
  deps: GitHubCredentialDependencies,
) {
  let privateKeyPromise: Promise<KeyObject> | undefined;
  let resolvedInstallationId = config.installationId;

  const privateKey = () => {
    privateKeyPromise ??= deps
      .readPrivateKey(config.privateKeyFile)
      .then((pem) => {
        try {
          return createPrivateKey(pem);
        } catch {
          throw new Error(
            `GitHub App private key is malformed: ${config.privateKeyFile}`,
          );
        }
      });
    return privateKeyPromise;
  };

  const jwt = async () => {
    const currentEpochSeconds = Math.floor(deps.now().getTime() / 1000);
    const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
    const payload = encodeJson({
      iat: currentEpochSeconds - 60,
      exp: currentEpochSeconds + 540,
      iss: config.clientId,
    });
    const content = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    signer.end();
    const signature = signer.sign(await privateKey()).toString('base64url');
    return `${content}.${signature}`;
  };

  const requestJson = async (
    url: string,
    method: 'GET' | 'POST',
    operation: string,
    body?: unknown,
  ) => {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method,
        headers: {
          ...API_HEADERS,
          Authorization: `Bearer ${await jwt()}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: deps.timeoutSignal(deps.requestTimeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error))
        throw new Error(`GitHub App request timed out while ${operation}`, {
          cause: error,
        });
      throw error;
    }
    if (!response.ok)
      throw new Error(
        `GitHub API request failed with status ${response.status}`,
      );
    return response.json() as Promise<unknown>;
  };

  const installationId = async () => {
    if (resolvedInstallationId !== undefined) return resolvedInstallationId;
    const response = await requestJson(
      `https://api.github.com/orgs/${encodeURIComponent(config.organization)}/installation`,
      'GET',
      'resolving the organization installation',
    );
    resolvedInstallationId = parseGitHubInstallationResponse(response).id;
    return resolvedInstallationId;
  };

  return { requestJson, installationId };
}

export interface ScopedInstallationTokenScope {
  repositories: string[];
  permissions: Record<string, 'read'>;
}

export async function createScopedInstallationToken(
  config: GitHubConfig,
  scope: ScopedInstallationTokenScope,
  dependencies: Partial<GitHubCredentialDependencies> = {},
): Promise<{ token: string; expiresAt: Date }> {
  if (config.mode !== 'app')
    throw new Error('Scoped tokens require GitHub App auth');
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const { requestJson, installationId } = createAppApi(config, deps);
  const id = await installationId();
  const response = await requestJson(
    `https://api.github.com/app/installations/${id}/access_tokens`,
    'POST',
    'creating a scoped installation token',
    { repositories: scope.repositories, permissions: scope.permissions },
  );
  return parseGitHubTokenResponse(response);
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function encodeJson(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
