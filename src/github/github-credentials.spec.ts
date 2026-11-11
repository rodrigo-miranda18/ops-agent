import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { type AppGitHubConfig } from '../config/github-config.js';
import {
  createGitHubCredentialProvider,
  createScopedInstallationToken,
  type ScopedInstallationTokenScope,
} from './github-credentials.js';

const now = new Date('2026-10-03T12:00:00.000Z');
const expiresAt = new Date('2026-10-03T13:00:00.000Z');
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const privateKeyPem = privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

function appConfig(overrides: Partial<AppGitHubConfig> = {}): AppGitHubConfig {
  return {
    mode: 'app',
    appId: '123',
    clientId: 'Iv1.client',
    organization: 'Example-org',
    healthRepository: 'service-15',
    privateKeyFile: '/run/secrets/github.pem',
    installationId: 456,
    tokenRefreshSkewMs: 300_000,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenResponse(
  token = 'installation-token',
  expiration = expiresAt,
): Response {
  return jsonResponse({ token, expires_at: expiration.toISOString() });
}

function decodeJwtPart(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('createGitHubCredentialProvider', () => {
  it('returns the configured static credential', async () => {
    const provider = createGitHubCredentialProvider({
      mode: 'static',
      token: 'static-token',
    });

    await expect(provider.getCredential()).resolves.toEqual({
      token: 'static-token',
      expiresAt: null,
      installationId: null,
    });
  });

  it('signs a GitHub App JWT with the client ID and clock tolerance', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse());
    const provider = createGitHubCredentialProvider(appConfig(), {
      fetch: fetchMock,
      now: () => now,
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
    });

    await provider.getCredential();

    const request = fetchMock.mock.calls[0];
    const headers = new Headers(request?.[1]?.headers);
    const authorization = headers.get('Authorization');
    expect(authorization).toMatch(/^Bearer /);
    const jwt = authorization?.slice('Bearer '.length) ?? '';
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split('.');
    expect(decodeJwtPart(encodedHeader)).toMatchObject({
      alg: 'RS256',
      typ: 'JWT',
    });
    const payload = decodeJwtPart(encodedPayload);
    const nowEpochSeconds = Math.floor(now.getTime() / 1000);
    expect(payload.iss).toBe('Iv1.client');
    expect(payload.iat).toBe(nowEpochSeconds - 60);
    expect(payload.exp).toBe(nowEpochSeconds + 540);
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        publicKey,
        Buffer.from(encodedSignature, 'base64url'),
      ),
    ).toBe(true);
    expect(headers.get('Accept')).toBe('application/vnd.github+json');
    expect(headers.get('X-GitHub-Api-Version')).toBe('2026-03-10');
  });

  it('resolves the organization installation when no ID is configured', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 789 }))
      .mockResolvedValueOnce(tokenResponse());
    const provider = createGitHubCredentialProvider(
      appConfig({ installationId: undefined }),
      {
        fetch: fetchMock,
        now: () => now,
        readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      },
    );

    await expect(provider.getCredential()).resolves.toMatchObject({
      installationId: 789,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/orgs/Example-org/installation',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.github.com/app/installations/789/access_tokens',
    );
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST');
  });

  it('rejects an installation response without a numeric ID', async () => {
    const provider = createGitHubCredentialProvider(
      appConfig({ installationId: undefined }),
      {
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse({ id: '789' })),
        now: () => now,
        readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      },
    );

    await expect(provider.getCredential()).rejects.toThrow(
      'GitHub installation response did not contain a numeric id',
    );
  });

  it.each([
    [{ expires_at: expiresAt.toISOString() }, 'non-empty token'],
    [{ token: '', expires_at: expiresAt.toISOString() }, 'non-empty token'],
    [{ token: 'token' }, 'valid expires_at'],
    [{ token: 'token', expires_at: 'invalid' }, 'valid expires_at'],
  ] as const)(
    'rejects an invalid token response %#',
    async (response, message) => {
      const provider = createGitHubCredentialProvider(appConfig(), {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response)),
        now: () => now,
        readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      });

      await expect(provider.getCredential()).rejects.toThrow(message);
    },
  );

  it('coalesces concurrent token refreshes', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending);
    const provider = createGitHubCredentialProvider(appConfig(), {
      fetch: fetchMock,
      now: () => now,
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
    });

    const credentials = [
      provider.getCredential(),
      provider.getCredential(),
      provider.getCredential(),
    ];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch?.(tokenResponse());

    await expect(Promise.all(credentials)).resolves.toEqual([
      expect.objectContaining({ token: 'installation-token' }),
      expect.objectContaining({ token: 'installation-token' }),
      expect.objectContaining({ token: 'installation-token' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the cache before the refresh boundary and refreshes at the boundary', async () => {
    let currentTime = now;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse('first-token'))
      .mockResolvedValueOnce(tokenResponse('second-token'));
    const provider = createGitHubCredentialProvider(appConfig(), {
      fetch: fetchMock,
      now: () => currentTime,
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
    });

    await expect(provider.getCredential()).resolves.toMatchObject({
      token: 'first-token',
    });
    currentTime = new Date(expiresAt.getTime() - 300_000 - 1);
    await expect(provider.getCredential()).resolves.toMatchObject({
      token: 'first-token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    currentTime = new Date(expiresAt.getTime() - 300_000);
    await expect(provider.getCredential()).resolves.toMatchObject({
      token: 'second-token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates only the cached installation token', async () => {
    const readPrivateKey = vi.fn().mockResolvedValue(privateKeyPem);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 789 }))
      .mockResolvedValueOnce(tokenResponse('first-token'))
      .mockResolvedValueOnce(tokenResponse('second-token'));
    const provider = createGitHubCredentialProvider(
      appConfig({ installationId: undefined }),
      { fetch: fetchMock, now: () => now, readPrivateKey },
    );

    await provider.getCredential();
    provider.invalidate();
    await expect(provider.getCredential()).resolves.toMatchObject({
      token: 'second-token',
      installationId: 789,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readPrivateKey).toHaveBeenCalledTimes(1);
  });

  it('applies an API deadline and reports token request timeouts', async () => {
    const signal = AbortSignal.abort(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );
    const timeoutSignal = vi.fn(() => signal);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      throw new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      );
    });
    const provider = createGitHubCredentialProvider(appConfig(), {
      fetch: fetchMock,
      now: () => now,
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
      requestTimeoutMs: 1234,
      timeoutSignal,
    });

    await expect(provider.getCredential()).rejects.toThrow(
      'GitHub App request timed out while creating an installation token',
    );
    expect(timeoutSignal).toHaveBeenCalledWith(1234);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it('reports malformed PEM by filename without exposing key material', async () => {
    const malformedPem = '-----BEGIN PRIVATE KEY-----\nsecret-material\n';
    const provider = createGitHubCredentialProvider(appConfig(), {
      fetch: vi.fn<typeof fetch>(),
      now: () => now,
      readPrivateKey: vi.fn().mockResolvedValue(malformedPem),
    });

    const error = await provider
      .getCredential()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('/run/secrets/github.pem');
    expect((error as Error).message).not.toContain('secret-material');
  });
});

describe('createScopedInstallationToken', () => {
  const scope: ScopedInstallationTokenScope = {
    repositories: ['service-17'],
    permissions: { contents: 'read', pull_requests: 'read' },
  };

  it('posts the scoped body and leaves the provider cache untouched', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse('scoped-token'))
      .mockResolvedValueOnce(tokenResponse('provider-token'));
    const deps = {
      fetch: fetchMock,
      now: () => now,
      readPrivateKey: vi.fn().mockResolvedValue(privateKeyPem),
    };

    await expect(
      createScopedInstallationToken(appConfig(), scope, deps),
    ).resolves.toEqual({ token: 'scoped-token', expiresAt });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/app/installations/456/access_tokens',
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      '{"repositories":["service-17"],"permissions":{"contents":"read","pull_requests":"read"}}',
    );

    const provider = createGitHubCredentialProvider(appConfig(), deps);
    await expect(provider.getCredential()).resolves.toMatchObject({
      token: 'provider-token',
    });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it('requires GitHub App auth', async () => {
    await expect(
      createScopedInstallationToken(
        { mode: 'static', token: 'static-token' },
        scope,
      ),
    ).rejects.toThrow('Scoped tokens require GitHub App auth');
  });
});
