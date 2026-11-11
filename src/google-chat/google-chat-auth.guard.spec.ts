import type { ExecutionContext, HttpException } from '@nestjs/common';
import { OAuth2Client, type LoginTicket } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleChatConfig } from '../config/google-chat-config.js';
import { GoogleChatAuthGuard } from './google-chat-auth.guard.js';

function httpContext(authorization?: string, body: unknown = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization }, body }),
    }),
  } as unknown as ExecutionContext;
}

function verifiedAs(email: string, emailVerified = true) {
  return vi
    .spyOn(OAuth2Client.prototype, 'verifyIdToken')
    .mockImplementation(async () => {
      const ticket = {
        getPayload: () => ({ email, email_verified: emailVerified }),
      };
      return ticket as unknown as LoginTicket;
    });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const exception = error as HttpException;
    return { status: exception.getStatus(), message: exception.getResponse() };
  }
  throw new Error('expected rejection');
}

const config = googleChatConfig({
  GOOGLE_CHAT_AUDIENCE: 'https://ops.example/google-chat/events',
});

describe('GoogleChatAuthGuard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a verified token from the Chat caller', async () => {
    const verify = verifiedAs('chat@system.gserviceaccount.com');
    const guard = new GoogleChatAuthGuard(config);
    await expect(guard.canActivate(httpContext('Bearer jwt'))).resolves.toBe(
      true,
    );
    expect(verify).toHaveBeenCalledWith({
      idToken: 'jwt',
      audience: 'https://ops.example/google-chat/events',
    });
  });

  it('accepts the system id token from the event body', async () => {
    const verify = verifiedAs('chat@system.gserviceaccount.com');
    const guard = new GoogleChatAuthGuard(config);
    const body = { authorizationEventObject: { systemIdToken: 'body-jwt' } };
    await expect(guard.canActivate(httpContext(undefined, body))).resolves.toBe(
      true,
    );
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ idToken: 'body-jwt' }),
    );
  });

  it('rejects a token from another caller', async () => {
    verifiedAs('someone@example.com');
    const guard = new GoogleChatAuthGuard(config);
    await expect(
      rejection(guard.canActivate(httpContext('Bearer jwt'))),
    ).resolves.toEqual({
      status: 401,
      message: 'Google Chat caller identity is invalid',
    });
  });

  it('rejects an unverified caller email', async () => {
    verifiedAs('chat@system.gserviceaccount.com', false);
    const guard = new GoogleChatAuthGuard(config);
    await expect(
      rejection(guard.canActivate(httpContext('Bearer jwt'))),
    ).resolves.toMatchObject({
      message: 'Google Chat caller email is not verified',
    });
  });

  it('rejects a missing token', async () => {
    const guard = new GoogleChatAuthGuard(config);
    await expect(rejection(guard.canActivate(httpContext()))).resolves.toEqual({
      status: 401,
      message: 'Google Chat request token is missing',
    });
  });

  it('skips verification when GOOGLE_CHAT_SKIP_AUTH is enabled', async () => {
    const verify = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken');
    const guard = new GoogleChatAuthGuard(
      googleChatConfig({ GOOGLE_CHAT_SKIP_AUTH: 'true' }),
    );
    await expect(guard.canActivate(httpContext())).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });
});
