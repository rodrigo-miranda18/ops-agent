import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseCommunicationOutput,
  type CommunicationOutput,
} from './communication-output.js';
import type { MediaImage } from './communication-media.js';
import type { ImprovementTicket, TicketOwner } from './communication.types.js';

export interface CommunicationVersionArtifacts {
  output: CommunicationOutput;
  tickets: ImprovementTicket[];
  warnings: string[];
  media: MediaImage[];
}

export async function readCommunicationArtifacts(
  artifactDir: string,
): Promise<CommunicationVersionArtifacts> {
  const rawOutput = await readOptionalJson(
    path.join(artifactDir, 'output.json'),
  );
  if (rawOutput === null) throw new Error('output.json não foi gerado');
  const output = parseCommunicationOutput(rawOutput);
  const context = await readOptionalJson(
    path.join(artifactDir, 'context', 'clickup.json'),
  );
  const warnings = await readOptionalJson(
    path.join(artifactDir, 'context', 'warnings.json'),
  );
  return {
    output,
    tickets: improvementTickets(context),
    warnings: stringList(warnings),
    media: mediaImages(
      await readOptionalJson(path.join(artifactDir, 'media.json')),
    ),
  };
}

async function readOptionalJson(filename: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`${path.basename(filename)} não é um JSON válido`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function mediaImages(value: unknown): MediaImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!isRecord(item)) return [];
    const { name, url, caption } = item;
    return typeof name === 'string' &&
      typeof url === 'string' &&
      typeof caption === 'string'
      ? [{ name, url, caption }]
      : [];
  });
}

function ticketOwners(value: unknown): TicketOwner[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (
      !isRecord(item) ||
      typeof item.username !== 'string' ||
      !item.username.trim()
    )
      return [];
    return [
      {
        username: item.username,
        email:
          typeof item.email === 'string' && item.email.trim()
            ? item.email.trim().toLowerCase()
            : null,
      },
    ];
  });
}

function improvementTickets(context: unknown): ImprovementTicket[] {
  if (!isRecord(context) || !Array.isArray(context.improvementTickets))
    return [];
  return context.improvementTickets.flatMap((item: unknown) => {
    if (!isRecord(item)) return [];
    const { id, customId, name, url } = item;
    if (
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      typeof url !== 'string'
    )
      return [];
    const owners = ticketOwners(
      Array.isArray(item.owners) ? item.owners : [item.creator],
    );
    return [
      {
        id,
        customId: typeof customId === 'string' ? customId : null,
        name,
        url,
        owners,
      },
    ];
  });
}
