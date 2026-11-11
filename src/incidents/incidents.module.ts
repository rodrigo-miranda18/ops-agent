import { Module } from '@nestjs/common';
import { DiagnosisModule } from '../diagnosis/diagnosis.module.js';
import { GithubModule } from '../github/github.module.js';
import { GoogleChatModule } from '../google-chat/google-chat.module.js';
import { StateModule } from '../state/state.module.js';
import { IncidentsController } from './incidents.controller.js';
import { IncidentRecurrenceService } from './incident-recurrence.service.js';
import { IncidentsService } from './incidents.service.js';

@Module({
  imports: [StateModule, DiagnosisModule, GithubModule, GoogleChatModule],
  controllers: [IncidentsController],
  providers: [IncidentsService, IncidentRecurrenceService],
})
export class IncidentsModule {}
