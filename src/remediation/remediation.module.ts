import { Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module.js';
import { StalePullRequestCleanupService } from './stale-pull-request-cleanup.service.js';
import { StalePullRequestScheduler } from './stale-pull-request.scheduler.js';

@Module({
  imports: [GithubModule],
  providers: [StalePullRequestCleanupService, StalePullRequestScheduler],
})
export class RemediationModule {}
