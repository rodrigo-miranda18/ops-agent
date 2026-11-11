import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { DiagnosisExecutionService } from './diagnosis-execution.service.js';

@Injectable()
export class DiagnosisScheduler implements OnModuleInit {
  private readonly logger = new Logger(DiagnosisScheduler.name);
  private inFlight = false;
  constructor(
    private readonly executions: DiagnosisExecutionService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    const job = CronJob.from({
      cronTime: this.config.diagnosisCron,
      onTick: () => this.execute(),
    });
    this.scheduler.addCronJob('diagnosis', job);
    job.start();
  }

  async execute() {
    if (!this.config.diagnosisCronEnabled) {
      this.logger.debug('Diagnosis cron is disabled');
      return;
    }
    if (this.inFlight) {
      this.logger.debug('Diagnosis cron skipped: previous cron run in flight');
      return;
    }
    this.inFlight = true;
    const startedAt = Date.now();
    this.logger.log('Diagnosis cron started');
    try {
      const { runId, completion } = await this.executions.enqueue({
        source: 'cron',
        remediation: 'auto',
        notify: true,
      });
      this.logger.log(`Diagnosis cron queued as ${runId}`);
      await completion;
      this.logger.log(
        `Diagnosis cron finished successfully in ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      this.logger.error(
        `Diagnosis cron failed after ${Date.now() - startedAt}ms: ${(error as Error).message}`,
      );
    } finally {
      this.inFlight = false;
    }
  }
}
