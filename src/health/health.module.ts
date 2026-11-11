import { Module } from '@nestjs/common';
import { AppHealthController } from './app-health.controller.js';
import { HealthController } from './health.controller.js';
import { GithubModule } from '../github/github.module.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [GithubModule],
  controllers: [AppHealthController, HealthController],
  providers: [HealthService],
})
export class HealthModule {}
