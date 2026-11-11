import { Injectable, Logger } from '@nestjs/common';
import type { ChatEvent } from '../google-chat/google-chat.types.js';
import { CommunicationExecutionService } from './communication-execution.service.js';
import {
  CommunicationStore,
  isPublished,
  type CommunicationRecord,
} from './communication-store.js';

@Injectable()
export class CommunicationThreadService {
  private readonly logger = new Logger(CommunicationThreadService.name);

  constructor(
    private readonly store: CommunicationStore,
    private readonly execution: CommunicationExecutionService,
  ) {}

  async handleMessage(event: ChatEvent): Promise<{ text: string } | null> {
    const threadName = event.message?.thread?.name;
    if (!threadName) return null;
    const record = await this.store.findByThread(threadName);
    if (!record || record.space !== event.space?.name) return null;

    const user = event.user || event.message?.sender;
    if (user?.name !== record.requester.user)
      return { text: 'Só quem pediu a comunicação pode ajustá-la.' };
    if (isPublished(record))
      return {
        text: 'Esta comunicação já foi publicada. Use /comunicacao para gerar uma nova.',
      };
    const feedback = (
      event.message?.argumentText ||
      event.message?.text ||
      ''
    ).trim();
    if (!feedback)
      return { text: 'Envie o ajuste que você quer na comunicação.' };
    const generating = generatingVersion(record);
    if (generating !== null) return busyReply(generating);

    const started = await this.store.startVersion(record.id, feedback);
    if ('busy' in started) {
      const current = await this.store.find(record.id);
      return busyReply(
        (current && generatingVersion(current)) ?? record.versions.length + 1,
      );
    }
    this.logger.log(
      `Communication ${record.id} v${started.version} requested with feedback`,
    );
    await this.execution.start({
      communicationId: record.id,
      version: started.version,
    });
    return {
      text: `Gerando a versão ${started.version} com o seu ajuste…`,
    };
  }
}

function generatingVersion(record: CommunicationRecord): number | null {
  return (
    record.versions.find((version) => version.status === 'generating')
      ?.number ?? null
  );
}

function busyReply(version: number) {
  return {
    text: `Ainda estou gerando a versão ${version}; envie o ajuste quando ela chegar.`,
  };
}
