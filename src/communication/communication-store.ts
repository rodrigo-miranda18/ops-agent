import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../config/runtime-config.js';
import { StateService } from '../state/state.service.js';

export const COMMUNICATION_STATE_FILE = 'communications.json';

export const COMMUNICATION_STATUSES_STATE = [
  'generating',
  'ready',
  'failed',
  'published',
] as const;
export type CommunicationStateStatus =
  (typeof COMMUNICATION_STATUSES_STATE)[number];

export type CommunicationVersionStatus = Exclude<
  CommunicationStateStatus,
  'published'
>;

export interface CommunicationVersion {
  number: number;
  createdAt: string;
  feedback: string | null;
  status: CommunicationVersionStatus;
  runId: string;
  cardMessageName: string | null;
  artifactDir: string;
}

export interface CommunicationTask {
  id: string;
  customId: string | null;
  name: string;
  url: string;
  teamId?: string | null;
}

export interface CommunicationRecord {
  id: string;
  requester: { user: string; displayName: string };
  apiOrigin?: boolean;
  space: string;
  threadName: string;
  task: CommunicationTask;
  status: CommunicationStateStatus;
  versions: CommunicationVersion[];
  published: {
    version: number;
    messageName: string;
    publishedAt: string;
    publishedBy: string;
  } | null;
  publishing?: { version: number; user: string; startedAt: string } | null;
}

export type CommunicationRecords = Record<string, CommunicationRecord>;

export interface CreateCommunicationInput {
  requester: { user: string; displayName: string };
  apiOrigin?: boolean;
  space: string;
  threadName: string;
  task: CommunicationTask;
}

export type PublicationClaim =
  'claimed' | 'already_published' | 'not_requester' | 'not_ready';

export interface StaleGeneration {
  id: string;
  version: number;
  space: string;
  threadName: string;
}

export function communicationArtifactDir(
  resultsDir: string,
  id: string,
  version: number,
): string {
  return path.join(resultsDir, 'communications', id, `v${version}`);
}

export function findCommunication(
  records: CommunicationRecords,
  id: string,
): CommunicationRecord | null {
  return Object.hasOwn(records, id) ? (records[id] ?? null) : null;
}

@Injectable()
export class CommunicationStore {
  constructor(
    private readonly state: StateService,
    @Inject(RUNTIME_CONFIG) private readonly runtime: RuntimeConfig,
  ) {}

  async create(input: CreateCommunicationInput): Promise<CommunicationRecord> {
    const id = randomUUID();
    const record: CommunicationRecord = {
      id,
      requester: input.requester,
      apiOrigin: input.apiOrigin ?? false,
      space: input.space,
      threadName: input.threadName,
      task: input.task,
      status: 'generating',
      versions: [this.newVersion(id, 1, null)],
      published: null,
      publishing: null,
    };
    await this.state.update<CommunicationRecords>(
      COMMUNICATION_STATE_FILE,
      (records) => {
        records[id] = record;
      },
    );
    return record;
  }

  async find(id: string): Promise<CommunicationRecord | null> {
    return findCommunication(
      await this.state.read<CommunicationRecords>(COMMUNICATION_STATE_FILE),
      id,
    );
  }

  async findByThread(threadName: string): Promise<CommunicationRecord | null> {
    const records = await this.state.read<CommunicationRecords>(
      COMMUNICATION_STATE_FILE,
    );
    return (
      Object.values(records).find(
        (record) => record.threadName === threadName,
      ) ?? null
    );
  }

  async startVersion(
    id: string,
    feedback: string | null,
  ): Promise<{ version: number } | { busy: true }> {
    let result: { version: number } | { busy: true } = { busy: true };
    await this.state.update<CommunicationRecords>(
      COMMUNICATION_STATE_FILE,
      (records) => {
        const record = required(records, id);
        if (record.versions.some((version) => version.status === 'generating'))
          return;
        const number = record.versions.length + 1;
        record.versions.push(this.newVersion(id, number, feedback));
        if (!isPublished(record)) record.status = 'generating';
        result = { version: number };
      },
    );
    return result;
  }

  async finishVersion(
    id: string,
    version: number,
    status: 'ready' | 'failed',
    cardMessageName?: string,
  ): Promise<void> {
    await this.state.update<CommunicationRecords>(
      COMMUNICATION_STATE_FILE,
      (records) => {
        const record = required(records, id);
        const entry = record.versions.find((item) => item.number === version);
        if (!entry)
          throw new Error(`Communication version not found: ${id} v${version}`);
        entry.status = status;
        if (cardMessageName) entry.cardMessageName = cardMessageName;
        if (!isPublished(record)) record.status = status;
      },
    );
  }

  async claimPublication(
    id: string,
    version: number,
    user: string,
  ): Promise<PublicationClaim> {
    let claim: PublicationClaim = 'not_ready';
    await this.state.update<CommunicationRecords>(
      COMMUNICATION_STATE_FILE,
      (records) => {
        const record = required(records, id);
        if (isPublished(record)) {
          claim = 'already_published';
          return;
        }
        if (!record.apiOrigin && record.requester.user !== user) {
          claim = 'not_requester';
          return;
        }
        const entry = record.versions.find((item) => item.number === version);
        if (entry?.status !== 'ready') {
          claim = 'not_ready';
          return;
        }
        record.publishing = {
          version,
          user,
          startedAt: new Date().toISOString(),
        };
        record.status = 'published';
        claim = 'claimed';
      },
    );
    return claim;
  }

  async completePublication(id: string, messageName: string): Promise<void> {
    await this.state.update<CommunicationRecords>(
      COMMUNICATION_STATE_FILE,
      (records) => {
        const record = required(records, id);
        if (!record.publishing)
          throw new Error(`Communication publication was not claimed: ${id}`);
        record.published = {
          version: record.publishing.version,
          messageName,
          publishedAt: new Date().toISOString(),
          publishedBy: record.publishing.user,
        };
        record.publishing = null;
        record.status = 'published';
      },
    );
  }

  async releasePublication(id: string): Promise<void> {
    await this.state.update<CommunicationRecords>(
      COMMUNICATION_STATE_FILE,
      (records) => {
        const record = required(records, id);
        if (record.published) return;
        record.publishing = null;
        record.status = 'ready';
      },
    );
  }

  async failStaleGenerations(): Promise<StaleGeneration[]> {
    const stale: StaleGeneration[] = [];
    await this.state.update<CommunicationRecords>(
      COMMUNICATION_STATE_FILE,
      (records) => {
        for (const record of Object.values(records)) {
          for (const version of record.versions) {
            if (version.status !== 'generating') continue;
            version.status = 'failed';
            stale.push({
              id: record.id,
              version: version.number,
              space: record.space,
              threadName: record.threadName,
            });
          }
          if (record.status === 'generating') record.status = 'failed';
        }
      },
    );
    return stale;
  }

  private newVersion(
    id: string,
    number: number,
    feedback: string | null,
  ): CommunicationVersion {
    return {
      number,
      createdAt: new Date().toISOString(),
      feedback,
      status: 'generating',
      runId: randomUUID(),
      cardMessageName: null,
      artifactDir: communicationArtifactDir(
        this.runtime.resultsDir,
        id,
        number,
      ),
    };
  }
}

export function isPublished(record: CommunicationRecord): boolean {
  return record.published !== null || Boolean(record.publishing);
}

function required(
  records: CommunicationRecords,
  id: string,
): CommunicationRecord {
  const record = findCommunication(records, id);
  if (!record) throw new Error(`Communication not found: ${id}`);
  return record;
}
