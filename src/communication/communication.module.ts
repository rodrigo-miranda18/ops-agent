import { Module } from '@nestjs/common';
import { ClickUpModule } from '../clickup/clickup.module.js';
import {
  COMMUNICATION_CONFIG,
  type CommunicationConfig,
} from '../config/communication-config.js';
import { DiagnosisApiKeyGuard } from '../diagnosis/diagnosis-api-key.guard.js';
import { GoogleChatModule } from '../google-chat/google-chat.module.js';
import { StateModule } from '../state/state.module.js';
import { CommunicationActionsService } from './communication-actions.service.js';
import { CommunicationCommandService } from './communication-command.service.js';
import { CommunicationController } from './communication.controller.js';
import { COMMUNICATION_VERSION_EVENTS } from './communication-events.js';
import { CommunicationExecutionService } from './communication-execution.service.js';
import { CommunicationNotifier } from './communication-notifier.service.js';
import { CommunicationStore } from './communication-store.js';
import { CommunicationThreadService } from './communication-thread.service.js';
import {
  COMMUNICATION_MEDIA_STORAGE,
  createMediaStorage,
} from './media-storage.js';

@Module({
  imports: [StateModule, ClickUpModule, GoogleChatModule],
  controllers: [CommunicationController],
  providers: [
    DiagnosisApiKeyGuard,
    {
      provide: COMMUNICATION_MEDIA_STORAGE,
      inject: [COMMUNICATION_CONFIG],
      useFactory: ({ media }: CommunicationConfig) =>
        media ? createMediaStorage(media) : null,
    },
    CommunicationStore,
    CommunicationExecutionService,
    CommunicationNotifier,
    {
      provide: COMMUNICATION_VERSION_EVENTS,
      useExisting: CommunicationNotifier,
    },
    CommunicationCommandService,
    CommunicationThreadService,
    CommunicationActionsService,
  ],
  exports: [
    CommunicationCommandService,
    CommunicationThreadService,
    CommunicationActionsService,
  ],
})
export class CommunicationModule {}
