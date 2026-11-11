import { Module } from '@nestjs/common';
import { StorageMaintenanceExecutionService } from './storage-maintenance-execution.service.js';
import { StorageMaintenanceScheduler } from './storage-maintenance.scheduler.js';

@Module({
  providers: [StorageMaintenanceExecutionService, StorageMaintenanceScheduler],
})
export class StorageMaintenanceModule {}
