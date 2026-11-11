import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateEngineeringAction } from './diagnosis-output.js';

export type ResumeCheckpoint = 'diagnosis-complete' | 'restart';

export async function readResumeCheckpoint(
  ticketDir: string,
): Promise<ResumeCheckpoint> {
  try {
    const [runContent, actionContent, ticketContent, diagnosis, comment] =
      await Promise.all([
        readFile(path.join(ticketDir, 'run.json'), 'utf8'),
        readFile(path.join(ticketDir, 'engineering-action.json'), 'utf8'),
        readFile(path.join(ticketDir, 'ticket.json'), 'utf8'),
        readFile(path.join(ticketDir, 'diagnosis.md'), 'utf8'),
        readFile(path.join(ticketDir, 'cs-comment.md'), 'utf8'),
      ]);
    const run = JSON.parse(runContent) as Record<string, unknown>;
    validateEngineeringAction(JSON.parse(actionContent));
    const ticket = JSON.parse(ticketContent) as unknown;
    return run.status === 'diagnosed' &&
      run.remediation_status === 'pending' &&
      typeof ticket === 'object' &&
      ticket !== null &&
      diagnosis.trim() !== '' &&
      comment.trim() !== ''
      ? 'diagnosis-complete'
      : 'restart';
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return 'restart';
    throw error;
  }
}
