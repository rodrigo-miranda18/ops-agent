import type { CommunicationRecord } from './communication-store.js';

export interface CommunicationRunnerArgs {
  communicationId: string;
  version: number;
  help: boolean;
}

export const HISTORY_VERSION_STATUSES = ['ready', 'failed'] as const;
export type HistoryVersionStatus = (typeof HISTORY_VERSION_STATUSES)[number];

export interface CommunicationHistoryEntry {
  version: number;
  status: HistoryVersionStatus | null;
  feedback: string | null;
  output: unknown;
}

const COMMUNICATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function parseCommunicationArgs(
  argv: readonly string[],
): CommunicationRunnerArgs {
  const values = new Map<string, string>();
  let help = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    const match = arg.match(/^--(communication-id|version)=(.*)$/);
    if (!match?.[1]) throw new Error(`Unknown argument: ${arg}`);
    values.set(match[1], match[2] ?? '');
  }
  if (help) return { communicationId: '', version: 0, help };
  const communicationId = values.get('communication-id') ?? '';
  if (!COMMUNICATION_ID_PATTERN.test(communicationId))
    throw new Error('--communication-id is required and must be a safe ID');
  const version = Number(values.get('version'));
  if (!Number.isInteger(version) || version < 1)
    throw new Error('--version must be a positive integer');
  return { communicationId, version, help };
}

export function buildCommunicationHistory(
  record: Pick<CommunicationRecord, 'versions'>,
  version: number,
  outputs: ReadonlyMap<number, unknown>,
): CommunicationHistoryEntry[] {
  if (version <= 1) return [];
  const feedbackOf = (number: number) =>
    record.versions.find((item) => item.number === number)?.feedback ?? null;
  const history: CommunicationHistoryEntry[] = record.versions
    .filter((item) => item.number < version)
    .sort((a, b) => a.number - b.number)
    .map((item) => ({
      version: item.number,
      status:
        item.status === 'ready' ? ('ready' as const) : ('failed' as const),
      feedback: item.feedback,
      output: outputs.get(item.number) ?? null,
    }));
  history.push({
    version,
    status: null,
    feedback: feedbackOf(version),
    output: null,
  });
  return history;
}
