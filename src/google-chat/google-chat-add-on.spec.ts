import { expect, it } from 'vitest';
import {
  addOnMessageResponse,
  chatCommandId,
  chatCommandMessage,
  chatCommandSpaceName,
  normalizeAddOnChatEvent,
} from './google-chat-add-on.js';

it('normalizes an add-on message payload into a MESSAGE event', () => {
  const event = normalizeAddOnChatEvent({
    chat: {
      user: { name: 'users/1', displayName: 'Rodrigo' },
      messagePayload: {
        space: { name: 'spaces/AAA' },
        message: { name: 'spaces/AAA/messages/1', text: 'oi' },
      },
    },
  });

  expect(event.type).toBe('MESSAGE');
  expect(event.space).toEqual({ name: 'spaces/AAA' });
  expect(event.user).toEqual({ name: 'users/1', displayName: 'Rodrigo' });
  expect(event.message).toEqual({ name: 'spaces/AAA/messages/1', text: 'oi' });
});

it('maps a button click action parameter to the invoked function', () => {
  const event = normalizeAddOnChatEvent({
    type: 'CARD_CLICKED',
    commonEventObject: { parameters: { action: 'assume_ticket', id: '42' } },
    chat: {
      buttonClickedPayload: {
        space: { name: 'spaces/BBB' },
        message: { name: 'spaces/BBB/messages/2' },
      },
    },
  });

  expect(event.type).toBe('CARD_CLICKED');
  expect(event.commonEventObject).toEqual({
    parameters: { action: 'assume_ticket', id: '42' },
    invokedFunction: 'assume_ticket',
  });
  expect(event.space).toEqual({ name: 'spaces/BBB' });
  expect(event.message).toEqual({ name: 'spaces/BBB/messages/2' });
});

it('falls back to the function parameter and prefers the chat space', () => {
  const event = normalizeAddOnChatEvent({
    commonEventObject: { parameters: { function: 'approve_cs_comment' } },
    chat: {
      space: { name: 'spaces/CHAT' },
      buttonClickedPayload: { space: { name: 'spaces/BUTTON' } },
    },
  });

  expect(event.commonEventObject?.invokedFunction).toBe('approve_cs_comment');
  expect(event.space).toEqual({ name: 'spaces/CHAT' });
});

it('detects added and removed from space events', () => {
  expect(
    normalizeAddOnChatEvent({
      chat: { addedToSpacePayload: { space: { name: 'spaces/NEW' } } },
    }),
  ).toMatchObject({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/NEW' } });
  expect(
    normalizeAddOnChatEvent({
      chat: { removedFromSpacePayload: { space: { name: 'spaces/OLD' } } },
    }),
  ).toMatchObject({
    type: 'REMOVED_FROM_SPACE',
    space: { name: 'spaces/OLD' },
  });
});

it('reads command id, message and space from an add-on app command payload', () => {
  const event = {
    chat: {
      appCommandPayload: {
        space: { name: 'spaces/dm' },
        appCommandMetadata: { appCommandId: 2 },
        message: {
          text: '/comunicacao x',
          thread: { name: 'spaces/dm/threads/t' },
        },
      },
    },
  };
  expect(chatCommandId(event)).toBe('2');
  expect(chatCommandMessage(event)?.thread?.name).toBe('spaces/dm/threads/t');
  expect(chatCommandSpaceName(event)).toBe('spaces/dm');
});

it('prefers the message slash command id', () => {
  expect(chatCommandId({ message: { slashCommand: { commandId: 1 } } })).toBe(
    '1',
  );
  expect(chatCommandId({ message: { text: '/processar' } })).toBeUndefined();
});

it('wraps a message in the add-on create message action', () => {
  expect(
    addOnMessageResponse({ text: 'ok', thread: { name: 'spaces/AAA/t/1' } }),
  ).toEqual({
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: {
          message: { text: 'ok', thread: { name: 'spaces/AAA/t/1' } },
        },
      },
    },
  });
});
