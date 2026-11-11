import { Module } from '@nestjs/common';
import { ClickUpModule } from '../clickup/clickup.module.js';
import { GithubModule } from '../github/github.module.js';
import { StateModule } from '../state/state.module.js';
import { GoogleChatMessengerService } from './google-chat-messenger.service.js';
import { GoogleChatThreadsService } from './google-chat-threads.service.js';
import { GoogleChatActionsService } from './google-chat-actions.service.js';
import { GoogleChatNotificationsService } from './google-chat-notifications.service.js';
import { GoogleChatConversationService } from './google-chat-conversation.service.js';

@Module({
  imports: [StateModule, ClickUpModule, GithubModule],
  providers: [
    GoogleChatMessengerService,
    GoogleChatThreadsService,
    GoogleChatActionsService,
    GoogleChatNotificationsService,
    GoogleChatConversationService,
  ],
  exports: [
    GoogleChatNotificationsService,
    GoogleChatActionsService,
    GoogleChatConversationService,
    GoogleChatMessengerService,
    GoogleChatThreadsService,
  ],
})
export class GoogleChatModule {}
