import { Controller, Get, UseGuards } from '@nestjs/common';
import { DiagnosisApiKeyGuard } from '../diagnosis/diagnosis-api-key.guard.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('dependencies')
  @UseGuards(DiagnosisApiKeyGuard)
  dependencies() {
    return this.health.dependencies();
  }
}
