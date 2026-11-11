import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { safeEqual } from '../common/safe-equal.js';
import {
  GOOGLE_CHAT_CONFIG,
  type GoogleChatConfig,
} from '../config/google-chat-config.js';
import { chatErrorDetails, logChatOperation } from './google-chat-log.js';
import type { ChatEvent } from './google-chat.types.js';

@Injectable()
export class GoogleChatAuthGuard implements CanActivate {
  private readonly logger = new Logger(GoogleChatAuthGuard.name);
  private readonly tokenVerifier = new OAuth2Client();

  constructor(
    @Inject(GOOGLE_CHAT_CONFIG) private readonly config: GoogleChatConfig,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    try {
      await this.verifyEvent(
        request.headers.authorization,
        request.body as ChatEvent,
      );
    } catch (error) {
      throw new HttpException(
        (error as Error).message,
        HttpStatus.UNAUTHORIZED,
      );
    }
    return true;
  }

  private async verifyEvent(
    authorization: string | undefined,
    event: ChatEvent,
  ) {
    const invokedFunction =
      event.commonEventObject?.invokedFunction ||
      event.action?.actionMethodName;
    const chatPayloadType = event.chat?.buttonClickedPayload
      ? 'buttonClicked'
      : event.chat?.messagePayload
        ? 'message'
        : event.chat?.appCommandPayload
          ? 'appCommand'
          : event.chat?.addedToSpacePayload
            ? 'addedToSpace'
            : event.chat?.removedFromSpacePayload
              ? 'removedFromSpace'
              : undefined;
    const requestContext = {
      eventType: event.type,
      invokedFunction,
      chatPayloadType,
      parameterKeys: Object.keys(event.commonEventObject?.parameters || {}),
      space: event.space?.name,
      hasAuthorizationHeader: Boolean(authorization),
      hasSystemIdToken: Boolean(event.authorizationEventObject?.systemIdToken),
    };
    logChatOperation(this.logger, 'google_chat_event_received', requestContext);
    if (this.config.skipAuth) {
      this.logger.warn(
        'Google Chat event authentication skipped because GOOGLE_CHAT_SKIP_AUTH=true',
      );
      return;
    }
    const token =
      authorization?.replace(/^Bearer\s+/i, '') ||
      event.authorizationEventObject?.systemIdToken;
    const audience = this.config.audience;
    try {
      if (!token) throw new Error('Google Chat request token is missing');
      if (!audience) {
        throw new Error(
          'Set GOOGLE_CHAT_AUDIENCE to the exact HTTP interaction endpoint URL configured in Google Chat',
        );
      }
      const verified = await this.tokenVerifier.verifyIdToken({
        idToken: token,
        audience,
      });
      const payload = verified.getPayload();
      const caller = payload?.email;
      if (payload?.email_verified !== true)
        throw new Error('Google Chat caller email is not verified');
      if (!safeEqual(caller, this.config.callerEmail))
        throw new Error('Google Chat caller identity is invalid');
      logChatOperation(this.logger, 'google_chat_event_authenticated', {
        ...requestContext,
        caller,
        audience,
      });
    } catch (error) {
      logChatOperation(
        this.logger,
        'google_chat_event_authentication_failed',
        {
          ...requestContext,
          configuredAudience: audience || null,
          tokenClaims: token ? unverifiedJwtMetadata(token) : null,
          error: chatErrorDetails(error),
        },
        'error',
      );
      throw error;
    }
  }
}

function unverifiedJwtMetadata(token: string) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'),
    ) as {
      aud?: unknown;
      iss?: unknown;
      email?: unknown;
    };
    return { audience: payload.aud, issuer: payload.iss, email: payload.email };
  } catch {
    return { malformed: true };
  }
}
