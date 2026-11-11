export type CommunicationRunnerMessage =
  | { type: 'communication-ready'; communicationId: string; version: number }
  | {
      type: 'communication-failed';
      communicationId: string;
      version: number;
      error: string;
    };

export function isCommunicationRunnerMessage(
  value: unknown,
): value is CommunicationRunnerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (
    typeof message.communicationId !== 'string' ||
    message.communicationId === '' ||
    typeof message.version !== 'number' ||
    !Number.isInteger(message.version) ||
    message.version < 1
  )
    return false;
  if (message.type === 'communication-ready') return true;
  return (
    message.type === 'communication-failed' && typeof message.error === 'string'
  );
}
