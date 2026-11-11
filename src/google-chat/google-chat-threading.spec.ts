import { expect, it } from 'vitest';
import * as threading from './google-chat-threading.js';

it('creates a stable ticket thread key and rejects an empty ticket id', () => {
  expect(threading.ticketThreadKey(' 86tkt0012 ')).toBe(
    'driva-ticket-86tkt0012',
  );
  expect(threading.ticketThreadKey('TICKET 42')).toBe('driva-ticket-TICKET-42');
  expect(() => threading.ticketThreadKey('   ')).toThrow(
    /Ticket ID is required/,
  );
});

it('prefers the persisted ticket thread, then a new source thread, then the deterministic key', () => {
  const records = [
    {
      space: 'spaces/AAA',
      taskId: '42',
      threadName: 'spaces/AAA/threads/live',
      threadKey: 'driva-ticket-42',
    },
  ];
  expect(
    threading.selectTicketThreadAddress(
      records,
      'spaces/AAA',
      '42',
      'spaces/AAA/threads/source',
    ),
  ).toStrictEqual({ threadName: 'spaces/AAA/threads/live' });
  expect(
    threading.selectTicketThreadAddress(records, 'spaces/AAA', '42'),
  ).toStrictEqual({ threadName: 'spaces/AAA/threads/live' });
  expect(
    threading.selectTicketThreadAddress(
      records,
      'spaces/BBB',
      '42',
      'spaces/BBB/threads/source',
    ),
  ).toStrictEqual({ threadName: 'spaces/BBB/threads/source' });
  expect(
    threading.selectTicketThreadAddress(records, 'spaces/BBB', '42'),
  ).toStrictEqual({ threadKey: 'driva-ticket-42' });
  expect(
    threading.selectTicketThreadAddress(
      [{ space: 'spaces/AAA', taskId: '42', threadKey: 'driva-ticket-42' }],
      'spaces/AAA',
      '42',
    ),
  ).toStrictEqual({ threadKey: 'driva-ticket-42' });
});

it('builds an exact reply-or-create request for a named thread', () => {
  expect(
    threading.createMessageRequest(
      'spaces/AAA',
      { text: 'diagnóstico' },
      { threadName: 'spaces/AAA/threads/123' },
    ),
  ).toStrictEqual({
    url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    body: { text: 'diagnóstico', thread: { name: 'spaces/AAA/threads/123' } },
  });
});

it('requires an existing thread for strict replies without changing the default policy', () => {
  expect(
    threading.createMessageRequest(
      'spaces/AAA',
      { text: 'comunicação' },
      { threadName: 'spaces/AAA/threads/123', requireExistingThread: true },
    ),
  ).toStrictEqual({
    url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?messageReplyOption=REPLY_MESSAGE_OR_FAIL',
    body: { text: 'comunicação', thread: { name: 'spaces/AAA/threads/123' } },
  });
});

it('adds a stable request id to message creation', () => {
  expect(
    threading.createMessageRequest(
      'spaces/AAA',
      { text: 'diagnóstico' },
      {},
      'request-123',
    ).url,
  ).toBe(
    'https://chat.googleapis.com/v1/spaces/AAA/messages?requestId=request-123',
  );
});

it('resolves inbound context only for the exact space and thread pair', () => {
  const record = {
    space: 'spaces/AAA',
    taskId: '42',
    threadName: 'spaces/AAA/threads/123',
    threadKey: 'driva-ticket-42',
  };
  expect(
    threading.findTicketThread(
      [record],
      'spaces/AAA',
      'spaces/AAA/threads/123',
    ),
  ).toBe(record);
  expect(
    threading.findTicketThread(
      [record],
      'spaces/BBB',
      'spaces/AAA/threads/123',
    ),
  ).toBe(undefined);
  expect(
    threading.findTicketThread(
      [record],
      'spaces/AAA',
      'spaces/AAA/threads/other',
    ),
  ).toBe(undefined);
});

it('uses a thread key for idempotent creation and leaves unrelated messages unthreaded', () => {
  expect(
    threading.createMessageRequest(
      'spaces/AAA',
      { cardsV2: [] },
      { threadKey: 'driva-ticket-42' },
    ),
  ).toStrictEqual({
    url: 'https://chat.googleapis.com/v1/spaces/AAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    body: { cardsV2: [], thread: { threadKey: 'driva-ticket-42' } },
  });
  expect(
    threading.createMessageRequest('spaces/AAA', { text: 'geral' }),
  ).toStrictEqual({
    url: 'https://chat.googleapis.com/v1/spaces/AAA/messages',
    body: { text: 'geral' },
  });
});

it('builds a Chat link for a thread name', () => {
  expect(threading.chatThreadUrl('spaces/AAA/threads/BBB')).toBe(
    'https://chat.google.com/room/AAA/BBB',
  );
  expect(threading.chatThreadUrl(undefined)).toBeNull();
  expect(threading.chatThreadUrl('spaces/AAA')).toBeNull();
});
