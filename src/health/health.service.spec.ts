import { agentConfigFromEnv } from '../config/agent-config.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeChildProcess } from '../common/fake-child-process.js';
import type { GitHubConfig } from '../config/github-config.js';
import type { RuntimeConfig } from '../config/runtime-config.js';
import type { GithubService } from '../github/github.service.js';
import type { GitHubCredentialProvider } from '../github/github-credentials.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { HealthService } = await import('./health.service.js');

const COMPLETE_ENV = {
  CODEX_MODEL: 'model',
  DRIVA_PROXY_API_KEY: 'key',
  GITHUB_AUTH_MODE: 'static',
  GH_TOKEN: 'token',
  GITHUB_DDS_TOKEN: 'packages-token',
  CLICKUP_API_TOKEN: 'token',
  CLICKUP_LIST_ID: 'list',
  CLICKUP_AREA_VALUES: 'area',
  DIAGNOSIS_VECTORS: '{}',
  SALES_POSTGRESQL_HOST: 'h',
  SALES_POSTGRESQL_USERNAME: 'u',
  SALES_POSTGRESQL_PASSWORD: 'p',
  SALES_POSTGRESQL_DATABASE: 'd',
  CLICKHOUSE_URL: 'http://clickhouse',
  HUNTER_DATABASE_READONLY_URL: 'postgres://hunter',
  INTEGRATIONS_PG_HOST: 'h',
  INTEGRATIONS_PG_USER: 'u',
  INTEGRATIONS_PG_PASSWORD: 'p',
  INTEGRATIONS_PG_DATABASE: 'd',
  INTEGRATIONS_EXPORTS_PG_HOST: 'h',
  INTEGRATIONS_EXPORTS_PG_USER: 'u',
  INTEGRATIONS_EXPORTS_PG_PASSWORD: 'p',
  INTEGRATIONS_EXPORTS_PG_DATABASE: 'd',
  LINKEDIN_DATABASE_URL: 'postgres://linkedin',
  MAIL_POSTGRES_HOST: 'h',
  MAIL_POSTGRES_USERNAME: 'u',
  MAIL_POSTGRES_PASSWORD: 'p',
  MAIL_POSTGRES_DATABASE: 'd',
  MANAGEMENT_PG_HOST: 'h',
  MANAGEMENT_PG_USER: 'u',
  MANAGEMENT_PG_PASSWORD: 'p',
  MANAGEMENT_PG_DATABASE: 'd',
  MARKET_INTELLIGENCE_STORAGE_S3_BUCKET: 'bucket',
  MARKET_INTELLIGENCE_STORAGE_S3_ACCESS_KEY_ID: 'key',
  MARKET_INTELLIGENCE_STORAGE_S3_SECRET_ACCESS_KEY: 'secret',
  DRIVA_LIST_PG_HOST: 'h',
  DRIVA_LIST_PG_USER: 'u',
  DRIVA_LIST_PG_PASSWORD: 'p',
  DRIVA_LIST_PG_DATABASE: 'd',
  WHATSAPP_CLOUD_POSTGRES_HOST: 'h',
  WHATSAPP_CLOUD_POSTGRES_USERNAME: 'u',
  WHATSAPP_CLOUD_POSTGRES_PASSWORD: 'p',
  WHATSAPP_CLOUD_POSTGRES_DATABASE: 'd',
  GOOGLE_CLOUD_PROJECT_NUMBER: '123',
};

const STATIC_CONFIG: GitHubConfig = { mode: 'static', token: 'token' };

const APP_CONFIG = {
  mode: 'app',
  appId: '123',
  clientId: 'Iv1.client',
  organization: 'Example-org',
  healthRepository: 'service-15',
  privateKeyFile: '/app/secrets/github.pem',
  installationId: 456,
  tokenRefreshSkewMs: 300_000,
} satisfies GitHubConfig;

describe('HealthService', () => {
  let root: string;
  let children: Map<string, FakeChildProcess>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'health-'));
    await mkdir(path.join(root, 'repos', 'org', 'service', '.git'), {
      recursive: true,
    });
    await mkdir(path.join(root, 'state'));
    await mkdir(path.join(root, 'results'));
    await writeFile(path.join(root, 'credentials.json'), '{}');
    children = new Map();
    spawnMock.mockReset().mockImplementation((command, args) => {
      const child = new FakeChildProcess();
      children.set(`${command} ${(args as string[]).join(' ')}`, child);
      return child;
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  function service(
    env: NodeJS.ProcessEnv = {},
    config: GitHubConfig = STATIC_CONFIG,
    credentials: GitHubCredentialProvider = {
      getCredential: vi.fn().mockResolvedValue({
        token: 'token',
        expiresAt: null,
        installationId: null,
      }),
      invalidate: vi.fn(),
    },
    execute = vi.fn().mockResolvedValue('ok'),
  ) {
    const runtime = {
      reposDir: path.join(root, 'repos'),
      stateDir: path.join(root, 'state'),
      resultsDir: path.join(root, 'results'),
      codexBin: 'codex',
      agent: agentConfigFromEnv({}),
      processEnv: env,
    } as RuntimeConfig;
    const github = { execute } as Pick<GithubService, 'execute'>;
    return {
      health: new HealthService(
        runtime,
        config,
        credentials,
        github as GithubService,
      ),
      execute,
      credentials,
    };
  }

  function appEnvironment() {
    return {
      ...COMPLETE_ENV,
      GITHUB_AUTH_MODE: 'app',
      GH_TOKEN: undefined,
      GITHUB_APP_ID: APP_CONFIG.appId,
      GITHUB_APP_CLIENT_ID: APP_CONFIG.clientId,
      GITHUB_APP_ORGANIZATION: APP_CONFIG.organization,
      GITHUB_APP_HEALTH_REPOSITORY: APP_CONFIG.healthRepository,
      GITHUB_APP_PRIVATE_KEY_FILE: path.join(root, 'credentials.json'),
      GITHUB_APP_INSTALLATION_ID: '456',
      GITHUB_APP_TOKEN_REFRESH_SKEW_SECONDS: '300',
      GOOGLE_APPLICATION_CREDENTIALS: path.join(root, 'credentials.json'),
    };
  }

  async function waitForCommands(count: number) {
    await vi.waitFor(() => expect(children.size).toBe(count));
  }

  function finishAll(overrides: Record<string, number | null> = {}) {
    for (const [key, child] of children) {
      child.finish(
        { stdout: `${key} v1\nextra` },
        key in overrides ? (overrides[key] ?? null) : 0,
      );
    }
  }

  it('verifies static credentials through the authenticated executor', async () => {
    const env = {
      ...COMPLETE_ENV,
      GOOGLE_APPLICATION_CREDENTIALS: path.join(root, 'credentials.json'),
    };
    const { health, execute } = service(env);
    const promise = health.dependencies();
    await waitForCommands(6);
    finishAll();
    const result = await promise;

    expect(result.status).toBe('ok');
    expect(result.checks.codex).toEqual({
      ok: true,
      version: 'codex --version v1',
    });
    expect(result.checks.githubAuth).toEqual({ ok: true, mode: 'static' });
    expect(execute).toHaveBeenCalledWith(['api', 'user', '--jq', '.login']);
    expect(result.checks.directories).toEqual({
      repos: { writable: true, repositories: 1 },
      state: { writable: true },
      results: { writable: true },
    });
    expect(result.checks.configuration.googleCredentials).toBe(true);
    expect(result.checks.configuration.githubPackages).toBe(true);
    expect(spawnMock).not.toHaveBeenCalledWith(
      'gh',
      ['auth', 'status'],
      expect.anything(),
    );
    expect(result.checks.python).toEqual({
      ok: true,
      version: 'python3 --version v1',
    });
  });

  it('reports App installation identity, expiration, and repository access', async () => {
    const expiresAt = new Date('2026-10-03T14:00:00.000Z');
    const credentials: GitHubCredentialProvider = {
      getCredential: vi.fn().mockResolvedValue({
        token: 'installation-token',
        expiresAt,
        installationId: 456,
      }),
      invalidate: vi.fn(),
    };
    const { health, execute } = service(
      appEnvironment(),
      APP_CONFIG,
      credentials,
    );

    const promise = health.dependencies();
    await waitForCommands(6);
    finishAll();
    const result = await promise;

    expect(credentials.getCredential).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith([
      'api',
      '/repos/Example-org/service-15',
      '--jq',
      '.full_name',
    ]);
    expect(result.checks.githubAuth).toEqual({
      ok: true,
      mode: 'app',
      appId: '123',
      installationId: 456,
      expiresAt: '2026-10-03T14:00:00.000Z',
      repositoryAccess: true,
    });
    expect(spawnMock).not.toHaveBeenCalledWith(
      'gh',
      ['auth', 'status'],
      expect.anything(),
    );
  });

  it('degrades App health with a sanitized credential error', async () => {
    const credentials: GitHubCredentialProvider = {
      getCredential: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'GitHub App private key is malformed: /app/secrets/github.pem\nAuthorization: Bearer secret-value',
          ),
        ),
      invalidate: vi.fn(),
    };
    const { health, execute } = service(
      appEnvironment(),
      APP_CONFIG,
      credentials,
    );

    const promise = health.dependencies();
    await waitForCommands(6);
    finishAll();
    const result = await promise;

    expect(result.status).toBe('degraded');
    expect(result.checks.githubAuth).toEqual({
      ok: false,
      mode: 'app',
      appId: '123',
      error:
        'GitHub App private key is malformed: /app/secrets/github.pem\nAuthorization: [REDACTED]',
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves permission and rate-limit failures as repository access errors', async () => {
    const expiresAt = new Date('2026-10-03T14:00:00.000Z');
    const credentials: GitHubCredentialProvider = {
      getCredential: vi.fn().mockResolvedValue({
        token: 'installation-token',
        expiresAt,
        installationId: 456,
      }),
      invalidate: vi.fn(),
    };
    const execute = vi
      .fn()
      .mockRejectedValue(new Error('HTTP 403: rate limit exceeded'));
    const { health } = service(
      appEnvironment(),
      APP_CONFIG,
      credentials,
      execute,
    );

    const promise = health.dependencies();
    await waitForCommands(6);
    finishAll();
    const result = await promise;

    expect(result.status).toBe('degraded');
    expect(result.checks.githubAuth).toEqual({
      ok: false,
      mode: 'app',
      appId: '123',
      installationId: 456,
      expiresAt: '2026-10-03T14:00:00.000Z',
      repositoryAccess: false,
      error: 'HTTP 403: rate limit exceeded',
    });
  });

  it('marca degraded quando um comando sai com exit code diferente de zero', async () => {
    const { health } = service(COMPLETE_ENV);
    const promise = health.dependencies();
    await waitForCommands(6);
    finishAll({ 'pnpm --version': 2 });
    const result = await promise;

    expect(result.status).toBe('degraded');
    expect(result.checks.pnpm).toEqual({ ok: false });
    expect(result.checks.configuration.googleCredentials).toBe(false);
  });

  it('marca o comando como indisponível quando o spawn falha', async () => {
    const { health } = service();
    const promise = health.dependencies();
    await waitForCommands(6);
    children.get('go version')?.emit('error', new Error('ENOENT'));
    finishAll();
    const result = await promise;

    expect(result.checks.go).toEqual({ ok: false });
    expect(result.status).toBe('degraded');
  });

  it('encerra com SIGTERM o comando que passa de 5 segundos', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { health } = service();
    const promise = health.dependencies();
    await waitForCommands(6);
    vi.advanceTimersByTime(5_000);

    for (const child of children.values()) {
      expect(child.killed).toEqual(['SIGTERM']);
    }
    finishAll(
      Object.fromEntries([...children.keys()].map((key) => [key, null])),
    );
    const result = await promise;
    expect(result.checks.codex).toEqual({ ok: false });
  });
});
