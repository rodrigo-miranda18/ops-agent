import { Inject, Injectable, Logger } from '@nestjs/common';
import { GoogleAuth } from 'google-auth-library';
import { normalize } from './google-chat-cards.js';
import {
  createMessageRequest,
  type TicketThreadAddress,
} from './google-chat-threading.js';
import { chatErrorDetails, logChatOperation } from './google-chat-log.js';
import {
  GOOGLE_CHAT_CONFIG,
  parseVectorSpaces,
  type GoogleChatConfig,
} from '../config/google-chat-config.js';

@Injectable()
export class GoogleChatMessengerService {
  private readonly logger = new Logger(GoogleChatMessengerService.name);
  private readonly auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/chat.bot'],
  });

  constructor(
    @Inject(GOOGLE_CHAT_CONFIG) private readonly config: GoogleChatConfig,
  ) {}

  sendText(
    space: string,
    text: string,
    thread: string | TicketThreadAddress = {},
  ) {
    const address =
      typeof thread === 'string' ? { threadName: thread } : thread;
    return this.sendMessage(space, { text }, address);
  }

  resolveSpaces(vectors: string[]) {
    const mapping = parseVectorSpaces(this.config.vectorSpacesJson);
    const normalized = new Map(
      Object.entries(mapping).map(([key, value]) => [normalize(key), value]),
    );
    return [
      ...new Set(
        vectors.flatMap((vector) => normalized.get(normalize(vector)) || []),
      ),
    ];
  }

  normalizeSpaceName(space: string) {
    return space.startsWith('spaces/') ? space : `spaces/${space}`;
  }

  async resolveMemberName(
    space: string,
    email: string,
  ): Promise<string | null> {
    const startedAt = Date.now();
    try {
      const headers = await this.authenticationHeaders();
      const member = encodeURIComponent(email.trim().toLowerCase());
      const response = await fetch(
        `https://chat.googleapis.com/v1/${this.normalizeSpaceName(space)}/members/${member}`,
        { headers, signal: AbortSignal.timeout(30_000) },
      );
      if (response.status === 404) return null;
      if (!response.ok) {
        const error = new Error(
          `Google Chat API ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
        Object.assign(error, {
          status: response.status,
          operation: 'getMembership',
        });
        throw error;
      }
      const membership: unknown = await response.json();
      if (typeof membership !== 'object' || membership === null) return null;
      const { member: user, state } = membership as Record<string, unknown>;
      if (state !== undefined && state !== 'JOINED') return null;
      if (typeof user !== 'object' || user === null) return null;
      const { name, type } = user as Record<string, unknown>;
      return type === 'HUMAN' &&
        typeof name === 'string' &&
        /^users\/\d+$/.test(name)
        ? name
        : null;
    } catch (error) {
      logChatOperation(
        this.logger,
        'google_chat_api_failed',
        {
          operation: 'getMembership',
          space,
          elapsedMs: Date.now() - startedAt,
          error: chatErrorDetails(error),
        },
        'error',
      );
      throw error;
    }
  }

  private async authenticationHeaders(): Promise<Headers> {
    const client = await this.auth.getClient();
    const headers = new Headers(await client.getRequestHeaders());
    headers.set('Content-Type', 'application/json');
    if (!headers.has('Authorization'))
      throw new Error(
        'Google authentication did not produce an Authorization header',
      );
    return headers;
  }

  async sendMessage(
    space: string,
    body: Record<string, unknown>,
    thread: TicketThreadAddress = {},
    requestId?: string,
  ) {
    const startedAt = Date.now();
    try {
      const headers = await this.authenticationHeaders();
      const request = createMessageRequest(space, body, thread, requestId);
      const response = await fetch(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const responseBody = (await response.text()).slice(0, 500);
        const error = new Error(
          `Google Chat API ${response.status}: ${responseBody}`,
        );
        Object.assign(error, {
          status: response.status,
          operation: 'createMessage',
        });
        throw error;
      }
      const message = (await response.json()) as {
        name?: string;
        thread?: { name?: string };
      };
      return {
        messageName: message.name || null,
        threadName: message.thread?.name,
      };
    } catch (error) {
      logChatOperation(
        this.logger,
        'google_chat_api_failed',
        {
          operation: 'createMessage',
          space,
          thread,
          elapsedMs: Date.now() - startedAt,
          error: chatErrorDetails(error),
        },
        'error',
      );
      throw error;
    }
  }
}
