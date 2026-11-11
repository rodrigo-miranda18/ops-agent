import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  GOOGLE_CHAT_CONFIG,
  type GoogleChatConfig,
} from '../config/google-chat-config.js';
import { GoogleChatMessengerService } from '../google-chat/google-chat-messenger.service.js';
import { readCommunicationArtifacts } from './communication-artifacts.js';
import { buildCommunicationCard } from './communication-cards.js';
import type { CommunicationVersionEvents } from './communication-events.js';
import { communicationTaskLabel } from './communication-text.js';
import {
  CommunicationStore,
  type CommunicationRecord,
} from './communication-store.js';

@Injectable()
export class CommunicationNotifier implements CommunicationVersionEvents {
  private readonly logger = new Logger(CommunicationNotifier.name);

  constructor(
    private readonly store: CommunicationStore,
    private readonly messenger: GoogleChatMessengerService,
    @Inject(GOOGLE_CHAT_CONFIG) private readonly config: GoogleChatConfig,
  ) {}

  async versionReady(input: {
    communicationId: string;
    version: number;
  }): Promise<void> {
    try {
      await this.postVersionCard(input);
    } catch (error) {
      this.logger.error(
        `Communication ${input.communicationId} v${input.version} could not be finalized, marking it failed: ${(error as Error).message}`,
      );
      try {
        await this.store.finishVersion(
          input.communicationId,
          input.version,
          'failed',
        );
      } catch (stateError) {
        this.logger.error(
          `Communication ${input.communicationId} v${input.version} is stuck: could not mark it failed: ${(stateError as Error).message}`,
        );
      }
      throw error;
    }
  }

  private async postVersionCard(input: {
    communicationId: string;
    version: number;
  }): Promise<void> {
    const record = await this.requireRecord(input.communicationId);
    const entry = record.versions.find(
      (version) => version.number === input.version,
    );
    if (!entry)
      throw new Error(
        `Communication version not found: ${input.communicationId} v${input.version}`,
      );
    let artifacts: Awaited<ReturnType<typeof readCommunicationArtifacts>>;
    try {
      artifacts = await readCommunicationArtifacts(entry.artifactDir);
    } catch (error) {
      await this.failVersion(
        record,
        input.version,
        `saída inválida (${(error as Error).message})`,
      );
      return;
    }
    let card: ReturnType<typeof buildCommunicationCard>;
    try {
      card = buildCommunicationCard(
        {
          ...artifacts,
          communicationId: record.id,
          version: input.version,
          taskLabel: communicationTaskLabel(record.task),
        },
        this.config.actionUrl,
      );
    } catch (error) {
      await this.failVersion(
        record,
        input.version,
        `não consegui montar o card por um erro de configuração do agente (${(error as Error).message})`,
      );
      return;
    }
    let messageName: string | null;
    try {
      const sent = await this.messenger.sendMessage(record.space, card, {
        threadName: record.threadName,
        requireExistingThread: true,
      });
      if (sent.threadName !== record.threadName)
        throw new Error('O Google Chat não confirmou a thread da comunicação.');
      messageName = sent.messageName;
    } catch (error) {
      await this.failVersion(
        record,
        input.version,
        `não consegui postar o card (${(error as Error).message})`,
      );
      return;
    }
    await this.store.finishVersion(
      record.id,
      input.version,
      'ready',
      messageName ?? undefined,
    );
    this.logger.log(
      `Communication ${record.id} v${input.version} card posted: ${messageName ?? 'unknown'}`,
    );
  }

  async versionFailed(input: {
    communicationId: string;
    version: number;
    error: string;
  }): Promise<void> {
    await this.failVersion(
      await this.requireRecord(input.communicationId),
      input.version,
      input.error,
    );
  }

  private async failVersion(
    record: CommunicationRecord,
    version: number,
    error: string,
  ) {
    this.logger.error(
      `Communication ${record.id} v${version} failed: ${error}`,
    );
    try {
      await this.store.finishVersion(record.id, version, 'failed');
    } catch (stateError) {
      this.logger.error(
        `Could not mark communication ${record.id} v${version} failed: ${(stateError as Error).message}`,
      );
    }
    await this.messenger.sendText(
      record.space,
      `A geração da versão ${version} falhou: ${error}\nEnvie uma mensagem nesta thread para tentar de novo.`,
      { threadName: record.threadName, requireExistingThread: true },
    );
  }

  private async requireRecord(id: string): Promise<CommunicationRecord> {
    const record = await this.store.find(id);
    if (!record) throw new Error(`Communication not found: ${id}`);
    return record;
  }
}
