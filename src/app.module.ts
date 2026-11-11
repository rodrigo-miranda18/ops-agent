import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from './config/config.module.js';
import { DiagnosisModule } from './diagnosis/diagnosis.module.js';
import { GoogleChatEventsModule } from './google-chat/google-chat-events.module.js';
import { HealthModule } from './health/health.module.js';
import { ImpactModule } from './impact/impact.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { RemediationModule } from './remediation/remediation.module.js';
import { StorageMaintenanceModule } from './storage-maintenance/storage-maintenance.module.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule,
    DiagnosisModule,
    GoogleChatEventsModule,
    HealthModule,
    ImpactModule,
    IncidentsModule,
    RemediationModule,
    StorageMaintenanceModule,
  ],
})
export class AppModule {}
