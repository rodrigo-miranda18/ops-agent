import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { StalePullRequestCleanupService } from './stale-pull-request-cleanup.service.js';

@Injectable()
export class StalePullRequestScheduler implements OnModuleInit {
  private readonly logger = new Logger(StalePullRequestScheduler.name);
  private inFlight = false;
  constructor(
    private readonly cleanup: StalePullRequestCleanupService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    const job = CronJob.from({
      cronTime: this.config.stalePrCleanupCron,
      onTick: () => this.execute(),
    });
    this.scheduler.addCronJob('stale-pull-request-cleanup', job);
    job.start();
  }

  async execute() {
    if (!this.config.stalePrCleanupEnabled) {
      this.logger.debug('Stale pull request cleanup is disabled');
      return;
    }
    if (this.inFlight) {
      this.logger.debug(
        'Stale pull request cleanup skipped: previous run in flight',
      );
      return;
    }
    this.inFlight = true;
    const startedAt = Date.now();
    this.logger.log('Stale pull request cleanup started');
    try {
      const { checked, closed, issuesChecked, issuesClosed, failed } =
        await this.cleanup.cleanup();
      this.logger.log(
        `Stale pull request cleanup finished in ${Date.now() - startedAt}ms: checked=${checked} closed=${closed.length} issuesChecked=${issuesChecked} issuesClosed=${issuesClosed.length} failed=${failed}`,
      );
    } catch (error) {
      this.logger.error(
        `Stale pull request cleanup failed after ${Date.now() - startedAt}ms: ${(error as Error).message}`,
      );
    } finally {
      this.inFlight = false;
    }
  }
}
