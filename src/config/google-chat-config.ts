import { type Environment } from './env.js';

function positiveIntegerOr(value: string | number, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const GOOGLE_CHAT_CONFIG = Symbol('GOOGLE_CHAT_CONFIG');

export type GoogleChatConfig = ReturnType<typeof googleChatConfig>;

export function googleChatConfig(env: Environment = process.env) {
  const timeoutMinutes = Number(
    env.GOOGLE_CHAT_CONVERSATION_TIMEOUT_MINUTES || 10,
  );
  return {
    notifyAfter: env.GOOGLE_CHAT_NOTIFY_AFTER,
    skipAuth: env.GOOGLE_CHAT_SKIP_AUTH === 'true',
    audience: env.GOOGLE_CHAT_AUDIENCE,
    actionUrl: env.GOOGLE_CHAT_ACTION_URL || env.GOOGLE_CHAT_AUDIENCE,
    callerEmail:
      env.GOOGLE_CHAT_CALLER_EMAIL || 'chat@system.gserviceaccount.com',
    vectorSpacesJson: env.GOOGLE_CHAT_VECTOR_SPACES_JSON || '{}',
    githubChatUserMapJson: env.GITHUB_CHAT_USER_MAP || '{}',
    processCommandId: env.GOOGLE_CHAT_PROCESS_COMMAND_ID || '1',
    communicationCommandId: env.GOOGLE_CHAT_COMMUNICATION_COMMAND_ID || '2',
    newsSpace: env.GOOGLE_CHAT_NEWS_SPACE,
    conversationHistoryTurns: positiveIntegerOr(
      env.GOOGLE_CHAT_CONVERSATION_HISTORY_TURNS || 10,
      10,
    ),
    conversationMaxMessageLength: positiveIntegerOr(
      env.GOOGLE_CHAT_CONVERSATION_MAX_MESSAGE_LENGTH || 4000,
      4000,
    ),
    conversationTimeoutMinutes:
      Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
        ? timeoutMinutes
        : 10,
    reorientationMaxMessageLength: positiveIntegerOr(
      env.GOOGLE_CHAT_REORIENTATION_MAX_MESSAGE_LENGTH || 4000,
      4000,
    ),
    reorientationConfirmationMinutes: positiveIntegerOr(
      env.GOOGLE_CHAT_REORIENTATION_CONFIRMATION_MINUTES || 60,
      60,
    ),
  };
}

export function requireGoogleChatActionUrl(url: string | undefined) {
  if (!url || !/^https:\/\//i.test(url))
    throw new Error(
      'Set GOOGLE_CHAT_ACTION_URL or GOOGLE_CHAT_AUDIENCE to the HTTPS interaction endpoint used by card actions',
    );
  return url;
}

export function parseVectorSpaces(json: string): Record<string, string[]> {
  const invalid = () =>
    new Error(
      'GOOGLE_CHAT_VECTOR_SPACES_JSON must be a JSON object mapping each vector to an array of spaces',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw invalid();
  const entries = Object.entries(parsed);
  if (
    !entries.every(
      ([, spaces]) =>
        Array.isArray(spaces) &&
        spaces.every((space) => typeof space === 'string'),
    )
  )
    throw invalid();
  return Object.fromEntries(entries) as Record<string, string[]>;
}
