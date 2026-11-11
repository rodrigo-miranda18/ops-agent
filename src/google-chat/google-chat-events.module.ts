import { Module } from '@nestjs/common';
import { ClickUpModule } from '../clickup/clickup.module.js';
import { CommunicationModule } from '../communication/communication.module.js';
import { DiagnosisModule } from '../diagnosis/diagnosis.module.js';
import { StateModule } from '../state/state.module.js';
import { GoogleChatController } from './google-chat.controller.js';
import { GoogleChatEventRouterService } from './google-chat-event-router.service.js';
import { GoogleChatDiagnosisCommandService } from './google-chat-diagnosis-command.service.js';
import { GoogleChatModule } from './google-chat.module.js';
import { GoogleChatRemediationReorientationService } from './google-chat-remediation-reorientation.service.js';

@Module({
  imports: [
    StateModule,
    ClickUpModule,
    GoogleChatModule,
    DiagnosisModule,
    CommunicationModule,
  ],
  controllers: [GoogleChatController],
  providers: [
    GoogleChatDiagnosisCommandService,
    GoogleChatRemediationReorientationService,
    GoogleChatEventRouterService,
  ],
})
export class GoogleChatEventsModule {}
