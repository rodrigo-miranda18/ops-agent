import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../state/atomic-write.js';

export { writeJsonAtomic };

export interface ImpactSnapshot {
  ticket_id: string;
}

interface ImpactHistory {
  ticket_id: string;
  evaluations: unknown[];
}

export async function persistCurrentImpact<T extends ImpactSnapshot>(
  ticketDir: string,
  snapshot: T,
): Promise<{ currentPath: string; historyPath: string; snapshot: T }> {
  const currentPath = path.join(ticketDir, 'customer-impact.json');
  const historyPath = path.join(ticketDir, 'customer-impact-history.json');
  let history: ImpactHistory = {
    ticket_id: snapshot.ticket_id,
    evaluations: [],
  };
  try {
    const stored = JSON.parse(await readFile(historyPath, 'utf8')) as unknown;
    if (isImpactHistory(stored) && stored.ticket_id === snapshot.ticket_id) {
      history = stored;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  history.evaluations.push(snapshot);
  await writeJsonAtomic(historyPath, history);
  await writeJsonAtomic(currentPath, snapshot);
  return { currentPath, historyPath, snapshot };
}

function isImpactHistory(value: unknown): value is ImpactHistory {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { evaluations?: unknown }).evaluations)
  );
}
