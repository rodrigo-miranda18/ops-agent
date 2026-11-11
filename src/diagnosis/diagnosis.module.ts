import { Module } from '@nestjs/common';
import { GoogleChatModule } from '../google-chat/google-chat.module.js';
import { StateModule } from '../state/state.module.js';
import { DiagnosisController } from './diagnosis.controller.js';
import { DiagnosisExecutionService } from './diagnosis-execution.service.js';
import { DiagnosisScheduler } from './diagnosis.scheduler.js';
import { RunRecoveryService } from './run-recovery.service.js';

@Module({
  imports: [StateModule, GoogleChatModule],
  controllers: [DiagnosisController],
  providers: [
    DiagnosisExecutionService,
    DiagnosisScheduler,
    RunRecoveryService,
  ],
  exports: [DiagnosisExecutionService],
})
export class DiagnosisModule {}
