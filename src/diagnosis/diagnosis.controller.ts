import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { DiagnosisExecutionService } from './diagnosis-execution.service.js';
import { CreateDiagnosisDto } from './create-diagnosis.dto.js';
import { DiagnosisApiKeyGuard } from './diagnosis-api-key.guard.js';

@UseGuards(DiagnosisApiKeyGuard)
@Controller('diagnoses')
export class DiagnosisController {
  constructor(private readonly executions: DiagnosisExecutionService) {}

  @Post()
  async create(@Body() body: CreateDiagnosisDto) {
    const googleChatSpace = body.googleChatSpace ?? body.googleChatUser;
    const { runId } = await this.executions.enqueue({
      ticketId: body.ticketId.trim(),
      source: 'manual',
      force: body.force === true,
      notify: body.notify !== false,
      remediation: body.remediation || 'auto',
      googleChatSpace: googleChatSpace?.trim(),
    });
    return { runId, status: 'queued' };
  }

  @Get(':runId')
  async get(@Param('runId') runId: string) {
    const run = await this.executions.get(runId);
    if (!run) throw new NotFoundException('Diagnosis run not found');
    return run;
  }
}
