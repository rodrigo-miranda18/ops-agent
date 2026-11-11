import { describe, expect, it } from 'vitest';
import {
  googleChatConfig,
  parseVectorSpaces,
  requireGoogleChatActionUrl,
} from './google-chat-config.js';

describe('googleChatConfig', () => {
  it('applies defaults when nothing is set', () => {
    expect(googleChatConfig({})).toEqual({
      notifyAfter: undefined,
      skipAuth: false,
      audience: undefined,
      actionUrl: undefined,
      callerEmail: 'chat@system.gserviceaccount.com',
      vectorSpacesJson: '{}',
      githubChatUserMapJson: '{}',
      processCommandId: '1',
      communicationCommandId: '2',
      newsSpace: undefined,
      conversationHistoryTurns: 10,
      conversationMaxMessageLength: 4000,
      conversationTimeoutMinutes: 10,
      reorientationMaxMessageLength: 4000,
      reorientationConfirmationMinutes: 60,
    });
  });

  it('falls back to defaults on invalid numbers', () => {
    const config = googleChatConfig({
      GOOGLE_CHAT_CONVERSATION_HISTORY_TURNS: '2.5',
      GOOGLE_CHAT_CONVERSATION_MAX_MESSAGE_LENGTH: '-1',
      GOOGLE_CHAT_CONVERSATION_TIMEOUT_MINUTES: 'abc',
      GOOGLE_CHAT_REORIENTATION_MAX_MESSAGE_LENGTH: '0',
      GOOGLE_CHAT_REORIENTATION_CONFIRMATION_MINUTES: 'x',
    });
    expect(config.conversationHistoryTurns).toBe(10);
    expect(config.conversationMaxMessageLength).toBe(4000);
    expect(config.conversationTimeoutMinutes).toBe(10);
    expect(config.reorientationMaxMessageLength).toBe(4000);
    expect(config.reorientationConfirmationMinutes).toBe(60);
  });

  it('accepts fractional conversation timeouts and strict skip auth', () => {
    const config = googleChatConfig({
      GOOGLE_CHAT_CONVERSATION_TIMEOUT_MINUTES: '0.5',
      GOOGLE_CHAT_SKIP_AUTH: 'yes',
    });
    expect(config.conversationTimeoutMinutes).toBe(0.5);
    expect(config.skipAuth).toBe(false);
  });
});

describe('requireGoogleChatActionUrl', () => {
  const actionUrl = (env: Record<string, string>) =>
    requireGoogleChatActionUrl(googleChatConfig(env).actionUrl);

  it('prefers the action url and falls back to the audience', () => {
    expect(
      actionUrl({
        GOOGLE_CHAT_ACTION_URL: 'https://action',
        GOOGLE_CHAT_AUDIENCE: 'https://audience',
      }),
    ).toBe('https://action');
    expect(actionUrl({ GOOGLE_CHAT_AUDIENCE: 'https://aud' })).toBe(
      'https://aud',
    );
  });

  it('requires an https endpoint', () => {
    expect(() => actionUrl({})).toThrow(
      'Set GOOGLE_CHAT_ACTION_URL or GOOGLE_CHAT_AUDIENCE',
    );
    expect(() => actionUrl({ GOOGLE_CHAT_ACTION_URL: 'http://x' })).toThrow(
      'Set GOOGLE_CHAT_ACTION_URL',
    );
  });
});

describe('parseVectorSpaces', () => {
  it('parses a vector to spaces mapping', () => {
    expect(parseVectorSpaces('{"Sequências":["spaces/A"]}')).toEqual({
      Sequências: ['spaces/A'],
    });
    expect(parseVectorSpaces('{}')).toEqual({});
  });

  it.each(['{not json', '[]', 'null', '"x"', '{"a":"spaces/A"}', '{"a":[1]}'])(
    'rejects %s',
    (json) => {
      expect(() => parseVectorSpaces(json)).toThrow(
        'GOOGLE_CHAT_VECTOR_SPACES_JSON must be a JSON object',
      );
    },
  );
});
