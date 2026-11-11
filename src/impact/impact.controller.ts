import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ImpactExecutionService } from './impact-execution.service.js';
import { CreateImpactDto } from './create-impact.dto.js';
import { DiagnosisApiKeyGuard } from '../diagnosis/diagnosis-api-key.guard.js';

@UseGuards(DiagnosisApiKeyGuard)
@Controller('impacts')
export class ImpactController {
  constructor(private readonly executions: ImpactExecutionService) {}

  @Post()
  async create(@Body() body: CreateImpactDto) {
    const { runId } = await this.executions.enqueue(body.ticketId.trim());
    return { runId, status: 'queued' };
  }

  @Get(':runId')
  async get(@Param('runId') runId: string) {
    const run = await this.executions.get(runId);
    if (!run) throw new NotFoundException('Impact run not found');
    return run;
  }
}
