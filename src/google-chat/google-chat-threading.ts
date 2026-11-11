export interface TicketThreadAddress {
  threadName?: string;
  threadKey?: string;
  requireExistingThread?: boolean;
}

export interface TicketThreadLookupRecord {
  space: string;
  taskId: string;
  threadName?: string;
  threadKey: string;
}

export function ticketThreadKey(taskId: string) {
  const normalized = taskId
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-');
  if (!normalized)
    throw new Error('Ticket ID is required to create a Google Chat thread key');
  return `driva-ticket-${normalized}`;
}

export function ticketThreadBindingKey(space: string, taskId: string) {
  return `${space}:${ticketThreadKey(taskId)}`;
}

export function selectTicketThreadAddress(
  records: TicketThreadLookupRecord[],
  space: string,
  taskId: string,
  preferredThreadName?: string,
): TicketThreadAddress {
  const persisted = records.find(
    (record) => record.space === space && record.taskId === taskId,
  );
  if (persisted?.threadName) return { threadName: persisted.threadName };
  if (preferredThreadName) return { threadName: preferredThreadName };
  return { threadKey: persisted?.threadKey || ticketThreadKey(taskId) };
}

export function findTicketThread<T extends TicketThreadLookupRecord>(
  records: T[],
  space: string,
  threadName: string,
) {
  return records.find(
    (record) => record.space === space && record.threadName === threadName,
  );
}

export function createMessageRequest(
  space: string,
  body: Record<string, unknown>,
  thread: TicketThreadAddress = {},
  requestId?: string,
) {
  const address = thread.threadName
    ? { name: thread.threadName }
    : thread.threadKey
      ? { threadKey: thread.threadKey }
      : null;
  const query = new URLSearchParams();
  if (address)
    query.set(
      'messageReplyOption',
      thread.requireExistingThread
        ? 'REPLY_MESSAGE_OR_FAIL'
        : 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    );
  if (requestId) query.set('requestId', requestId);
  const queryString = query.size ? `?${query.toString()}` : '';
  return {
    url: `https://chat.googleapis.com/v1/${encodeURI(space)}/messages${queryString}`,
    body: address ? { ...body, thread: address } : body,
  };
}

export function chatThreadUrl(threadName: string | undefined): string | null {
  const match = threadName?.match(/^spaces\/([^/]+)\/threads\/([^/]+)$/);
  return match ? `https://chat.google.com/room/${match[1]}/${match[2]}` : null;
}
