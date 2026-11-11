import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { parseClickUpLink } from '../clickup/clickup-link.js';
import { ClickUpService } from '../clickup/clickup.service.js';
import { DiagnosisApiKeyGuard } from '../diagnosis/diagnosis-api-key.guard.js';
import { GoogleChatMessengerService } from '../google-chat/google-chat-messenger.service.js';
import { ticketThreadKey } from '../google-chat/google-chat-threading.js';
import { CommunicationExecutionService } from './communication-execution.service.js';
import { CommunicationStore } from './communication-store.js';
import { communicationTask } from './communication-task.js';
import { CreateCommunicationDto } from './create-communication.dto.js';

const API_REQUESTER = {
  user: 'api',
  displayName: 'Rotina de comunicação',
};

@UseGuards(DiagnosisApiKeyGuard)
@Controller('communications')
export class CommunicationController {
  constructor(
    private readonly clickUp: ClickUpService,
    private readonly store: CommunicationStore,
    private readonly execution: CommunicationExecutionService,
    private readonly messenger: GoogleChatMessengerService,
  ) {}

  @Post()
  async create(@Body() body: CreateCommunicationDto) {
    const reference = parseClickUpLink(body.ticketId.trim());
    const clickUpTask = await this.clickUp.getTask(
      reference.taskId,
      reference.teamId,
    );
    const task = communicationTask(clickUpTask, reference.teamId);
    const space = this.messenger.normalizeSpaceName(body.deliverySpace.trim());
    const sent = await this.messenger.sendMessage(
      space,
      { text: `Comunicação - ${task.name}` },
      { threadKey: ticketThreadKey(task.id) },
    );
    if (!sent.threadName)
      throw new Error('O Google Chat não confirmou a thread da comunicação.');
    const record = await this.store.create({
      requester: API_REQUESTER,
      apiOrigin: true,
      space,
      threadName: sent.threadName,
      task,
    });
    await this.execution.start({ communicationId: record.id, version: 1 });
    return { communicationId: record.id, status: 'queued' };
  }
}
