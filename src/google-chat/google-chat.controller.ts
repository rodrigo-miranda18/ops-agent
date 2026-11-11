import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CommunicationCommandService } from '../communication/communication-command.service.js';
import { GoogleChatEventRouterService } from './google-chat-event-router.service.js';
import { GoogleChatAuthGuard } from './google-chat-auth.guard.js';
import { GoogleChatEventDto } from './google-chat-event.dto.js';
import { GoogleChatDiagnosisCommandService } from './google-chat-diagnosis-command.service.js';
import { GoogleChatRemediationReorientationService } from './google-chat-remediation-reorientation.service.js';

@Controller('google-chat')
export class GoogleChatController {
  constructor(
    private readonly router: GoogleChatEventRouterService,
    private readonly diagnosisCommand: GoogleChatDiagnosisCommandService,
    private readonly communicationCommand: CommunicationCommandService,
    private readonly remediationReorientation: GoogleChatRemediationReorientationService,
  ) {}

  @Post('events')
  @HttpCode(HttpStatus.OK)
  @UseGuards(GoogleChatAuthGuard)
  async event(@Body() event: GoogleChatEventDto) {
    const command = await this.diagnosisCommand.handle(event);
    if (command.handled) return command.response;
    const communication = await this.communicationCommand.handle(event);
    if (communication.handled) return communication.response;
    const reorientation = await this.remediationReorientation.handle(event);
    return reorientation.handled
      ? reorientation.response
      : this.router.handleEvent(event);
  }
}
