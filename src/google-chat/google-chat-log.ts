import type { Logger } from '@nestjs/common';

export type ChatLogLevel = 'log' | 'warn' | 'error';

export function logChatOperation(
  logger: Logger,
  event: string,
  details: Record<string, unknown>,
  level: ChatLogLevel = 'log',
) {
  const entry = JSON.stringify({ event, ...details });
  if (level === 'error') logger.error(entry);
  else if (level === 'warn') logger.warn(entry);
  else logger.log(entry);
}

export function chatErrorDetails(error: unknown) {
  const value = error as Error & {
    status?: unknown;
    operation?: unknown;
    code?: unknown;
  };
  return {
    name: value?.name || 'Error',
    message: redactChatLogValue(value?.message || String(error)).slice(0, 1000),
    status: value?.status,
    code: value?.code,
    operation: value?.operation,
  };
}

function redactChatLogValue(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /("?(?:access_token|id_token|authorization)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
      '$1[REDACTED]',
    );
}
