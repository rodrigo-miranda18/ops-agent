import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../state/atomic-write.js';

export function ticketResultsDir(resultsDir: string, ticketId: unknown) {
  return path.join(
    resultsDir,
    String(ticketId).replace(/[^A-Za-z0-9_-]/g, '_'),
  );
}

export async function removeIfExists(filename: string): Promise<void> {
  try {
    await unlink(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function writeTextArtifact(
  filename: string,
  content: string,
): Promise<void> {
  await writeFile(filename, content, { mode: 0o600 });
}

export async function writeStderrArtifact(
  filename: string,
  stderr: string,
): Promise<void> {
  await writeTextArtifact(filename, `${stderr.trimEnd()}\n`);
}

export async function readJsonArtifact(
  ticketDir: string,
  name: string,
): Promise<unknown> {
  return JSON.parse(await readFile(path.join(ticketDir, name), 'utf8'));
}

export async function updateRunArtifact(
  ticketDir: string,
  changes: Record<string, unknown>,
): Promise<void> {
  const runPath = path.join(ticketDir, 'run.json');
  const storedRun = JSON.parse(await readFile(runPath, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeJsonAtomic(runPath, Object.assign(storedRun, changes));
}
