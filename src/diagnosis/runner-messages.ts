export interface TicketDiagnosisReadyMessage {
  type: 'ticket-diagnosis-ready';
  ticketId: string;
}

export interface IncidentDiagnosisReadyMessage {
  type: 'incident-diagnosis-ready';
  incidentId: string;
}

export interface ItemLifecycleMessage {
  type: 'item-started' | 'item-finished';
  key: string;
}

export type RunnerMessage =
  | TicketDiagnosisReadyMessage
  | IncidentDiagnosisReadyMessage
  | ItemLifecycleMessage;

export interface IncidentNotificationAck {
  incidentId: string;
  error?: string;
}

export function isRunnerMessage(value: unknown): value is RunnerMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'ticket-diagnosis-ready')
    return typeof message.ticketId === 'string' && message.ticketId !== '';
  if (message.type === 'incident-diagnosis-ready')
    return typeof message.incidentId === 'string' && message.incidentId !== '';
  if (message.type === 'item-started' || message.type === 'item-finished')
    return typeof message.key === 'string' && message.key !== '';
  return false;
}

export function isIncidentNotificationAck(
  value: unknown,
): value is IncidentNotificationAck {
  if (typeof value !== 'object' || value === null) return false;
  const ack = value as Record<string, unknown>;
  return (
    typeof ack.incidentId === 'string' &&
    (ack.error === undefined || typeof ack.error === 'string')
  );
}
