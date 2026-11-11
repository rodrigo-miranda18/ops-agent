import { Allow } from 'class-validator';
import type { ChatEvent } from './google-chat.types.js';

export class GoogleChatEventDto implements ChatEvent {
  @Allow()
  type?: ChatEvent['type'];

  @Allow()
  authorizationEventObject?: ChatEvent['authorizationEventObject'];

  @Allow()
  commonEventObject?: ChatEvent['commonEventObject'];

  @Allow()
  action?: ChatEvent['action'];

  @Allow()
  space?: ChatEvent['space'];

  @Allow()
  user?: ChatEvent['user'];

  @Allow()
  message?: ChatEvent['message'];

  @Allow()
  chat?: ChatEvent['chat'];
}
