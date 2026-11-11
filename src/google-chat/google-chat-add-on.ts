import type { ChatEvent } from './google-chat.types.js';

export function normalizeAddOnChatEvent(event: ChatEvent): ChatEvent {
  const chat = event.chat!;
  const messagePayload = chat.messagePayload;
  const buttonPayload = chat.buttonClickedPayload;
  const parameters = event.commonEventObject?.parameters || {};
  const invokedFunction = parameters.action || parameters.function;
  const space =
    chat.space ||
    buttonPayload?.space ||
    messagePayload?.space ||
    chat.addedToSpacePayload?.space ||
    chat.removedFromSpacePayload?.space;
  const message = messagePayload?.message || buttonPayload?.message;
  return {
    ...event,
    type: messagePayload
      ? 'MESSAGE'
      : chat.addedToSpacePayload
        ? 'ADDED_TO_SPACE'
        : chat.removedFromSpacePayload
          ? 'REMOVED_FROM_SPACE'
          : event.type,
    commonEventObject: {
      ...event.commonEventObject,
      invokedFunction,
    },
    space,
    user: chat.user,
    message,
  };
}

export function addOnMessageResponse(message: {
  text?: string;
  cardsV2?: unknown;
  accessoryWidgets?: unknown;
  thread?: { name?: string };
}) {
  return {
    hostAppDataAction: {
      chatDataAction: {
        createMessageAction: { message },
      },
    },
  };
}

export function chatCommandMessage(event: ChatEvent) {
  return (
    event.message ||
    event.chat?.messagePayload?.message ||
    event.chat?.appCommandPayload?.message
  );
}

export function chatCommandSpaceName(event: ChatEvent) {
  return (
    event.space?.name ||
    event.chat?.space?.name ||
    event.chat?.messagePayload?.space?.name ||
    event.chat?.appCommandPayload?.space?.name
  );
}

export function chatCommandId(event: ChatEvent) {
  const commandId =
    chatCommandMessage(event)?.slashCommand?.commandId ??
    event.chat?.appCommandPayload?.appCommandMetadata?.appCommandId;
  return commandId === undefined ? undefined : String(commandId);
}

export function chatCommandReply(
  event: ChatEvent,
  text: string,
): { handled: true; response: unknown } {
  const sourceMessage = chatCommandMessage(event);
  const message = sourceMessage?.thread?.name
    ? { text, thread: { name: sourceMessage.thread.name } }
    : { text };
  const response = event.chat
    ? {
        hostAppDataAction: {
          chatDataAction: { createMessageAction: { message } },
        },
      }
    : message;
  return { handled: true, response };
}
