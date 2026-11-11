import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import {
  STORAGE_MAINTENANCE_CONFIG,
  type StorageMaintenanceConfig,
} from '../config/storage-maintenance-config.js';
import { StorageMaintenanceExecutionService } from './storage-maintenance-execution.service.js';
import { STORAGE_MAINTENANCE_SKIPPED_EXIT_CODE } from './storage-maintenance-runner.js';

@Injectable()
export class StorageMaintenanceScheduler implements OnModuleInit {
  private readonly logger = new Logger(StorageMaintenanceScheduler.name);
  private inFlight = false;

  constructor(
    private readonly executions: StorageMaintenanceExecutionService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(STORAGE_MAINTENANCE_CONFIG)
    private readonly config: StorageMaintenanceConfig,
  ) {}

  onModuleInit(): void {
    const job = CronJob.from({
      cronTime: this.config.cron,
      onTick: () => this.execute(),
    });
    this.scheduler.addCronJob('storage-maintenance', job);
    job.start();
  }

  async execute(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.debug('Storage maintenance cron is disabled');
      return;
    }
    if (this.inFlight) {
      this.logger.debug(
        'Storage maintenance cron skipped: previous run in flight',
      );
      return;
    }

    this.inFlight = true;
    const startedAt = Date.now();
    this.logger.log('Storage maintenance cron started');
    try {
      const exitCode = await this.executions.execute('cron');
      if (exitCode === STORAGE_MAINTENANCE_SKIPPED_EXIT_CODE) {
        this.logger.warn(
          `Storage maintenance cron skipped because another execution owns the lock after ${Date.now() - startedAt}ms`,
        );
        return;
      }
      if (exitCode !== 0)
        throw new Error(
          `Storage maintenance runner exited with code ${exitCode}`,
        );
      this.logger.log(
        `Storage maintenance cron finished successfully in ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      this.logger.error(
        `Storage maintenance cron failed after ${Date.now() - startedAt}ms: ${(error as Error).message}`,
      );
    } finally {
      this.inFlight = false;
    }
  }
}
